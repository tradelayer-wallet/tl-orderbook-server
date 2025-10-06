// src/services/orderbook/orderbook.class.ts
import * as native from '../../../rust/matcher-core/matcher_core.node';
import { Websocket } from "hyper-express";
import { ChannelSwap } from "../channel-swap/channel-swap.class";   // <- adjust
import { socketManager } from "../socket/manager.class";        
// Minimal shape the Rust core expects
type NativeOrder = {
  uuid: string;
  side: 'BUY' | 'SELL';
  price: number;
  amount: number;
  socket_id?: string;
};

type ConstructArg = string | { marketKey?: string; symbol?: string } | Record<string, any>;

function inferSymbol(arg: ConstructArg): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') {
    if (typeof (arg as any).marketKey === 'string') return (arg as any).marketKey!;
    if (typeof (arg as any).symbol === 'string') return (arg as any).symbol!;
  }
  return 'DEFAULT';
}

function normSide(x: any): 'BUY' | 'SELL' {
  const s =
    (x?.side ?? x?.action ?? x?.orderSide ?? '').toString().toLowerCase();
  return s === 'buy' ? 'BUY' : 'SELL';
}
function num(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeOrder(o: any): NativeOrder {
  return {
    uuid:
      (o?.uuid ?? o?.id ?? o?.orderId ?? o?.clientOrderId ?? o?.cid ?? '').toString(),
    side: normSide(o),
    price: num(o?.price ?? o?.price_num ?? o?.px),
    amount: num(o?.amount ?? o?.qty ?? o?.quantity ?? o?.size),
    socket_id: o?.socket_id ?? o?.socketId,
  };
}

export class Orderbook {
  public orderbookName: string;
  // keep these very loose so manager/socket code can stuff their own shapes
  public orders: any[] = [];
  public historyTrades: any[] = [];
  
  constructor(arg: ConstructArg) {
    this.orderbookName = inferSymbol(arg).toUpperCase();
    native.createBook(this.orderbookName);
  }

  // server-side owner index for resting orders
  const ownerByOrderId = new Map<string, string>();
  export public rememberOwner(orderId: string, socketId?: string) {
    if (orderId && socketId) ownerByOrderId.set(orderId, socketId);
  }
  export public forgetOwner(orderId: string) {
    if (orderId) ownerByOrderId.delete(orderId);
  }
  export public ownerOf(orderId: string): string | undefined {
    return ownerByOrderId.get(orderId);
  }

  public opposite(side: 'BUY'|'SELL'): 'BUY'|'SELL' { return side === 'BUY' ? 'SELL' : 'BUY'; }

// Heuristic: when the maker isn’t fully removed (no id in filled_order_ids),
// look up the current FIFO top at that price on the maker side.
export public findMakerOrderIdFromSnapshot(obSymbol: string, makerSide: 'BUY'|'SELL', price: number): string | undefined {
  try {
    const depth = 20; // plenty for best level
    const snap = JSON.parse(native.snapshot(obSymbol, depth));
    const book = snap?.snapshot;
    const levels = (makerSide === 'BUY' ? book?.bids : book?.asks) || [];
    const lvl = levels.find((l: any) => l.price === price);
    if (!lvl) return;
    // FIFO: first order on that level is the maker currently at top
    const first = lvl.orders?.[0];
    if (!first) return;
    const id = first.Standard?.id ?? first?.id;
    return id;
  } catch { return; }
}

  dispose() { native.dropBook(this.orderbookName); }

  // Manager calls this with ISpotOrder; accept anything.
  public checkCompatible(order: any): boolean {
    const want = inferSymbol(order).toUpperCase();
    return want === this.orderbookName;
  }

  public findByFilter(filter: string): boolean {
    return this.orderbookName.toLowerCase().includes((filter ?? '').toLowerCase());
  }

    public updatePlacedOrdersForSocketId(_socketId?: string): void {}

    // Accept anything and normalize for Rust
    // orderbook.class.ts

    // 1) single
    public async addOrder(order: TOrder, noTrades: boolean = false) {
      if (order?.uuid && order?.socket_id) this.rememberOwner(order.uuid, order.socket_id);

      const raw = core.submit(this.orderbookName, normalizeOrder(order));
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;

      if (!noTrades) {
        await this.processSubmitResult(this.orderbookName, order, res).catch(e =>
          console.error("[processSubmitResult]", e)
        );
      }
      return res;
    }

    // 2) batch
    public async addOrdersBatch(orders: TOrder[], noTrades: boolean = false) {
      for (const o of orders) if (o?.uuid && o?.socket_id) this.rememberOwner(o.uuid, o.socket_id);

      const raw = core.submitBatch(this.orderbookName, orders.map(normalizeOrder));
      const results: any[] = typeof raw === "string" ? JSON.parse(raw) : raw;

      if (!noTrades) {
        for (let i = 0; i < results.length; i++) {
          try {
            await this.processSubmitResult(this.orderbookName, orders[i], results[i]);
          } catch (e) {
            console.error("[processSubmitResult/batch]", e);
          }
        }
      }
      return results;
    }


  public removeOrder(orderId: string, _socket_id?: string) {
    return native.cancel(this.orderbookName, orderId);
  }

  public cancelAllBySocket(socketId: string) {
    return native.cancelAllBySocket(this.orderbookName, socketId);
  }

  public refresh(depth: number = 20): void {
    const json = native.snapshot(this.orderbookName, depth);
    try {
      const snap = JSON.parse(json);
      const toList = (levels: any, side: 'BUY' | 'SELL') =>
        Object.values(levels ?? {}).flatMap((lvl: any) =>
          (lvl.orders ?? []).map((o: any) => ({
            uuid: o.id ?? '',
            side,
            price: lvl.price ?? 0,
            amount: o.quantity ?? 0,
            lock: false,
          })),
        );
      this.orders = [...toList(snap.bids, 'BUY'), ...toList(snap.asks, 'SELL')];
    } catch {
      this.orders = [];
    }
  }

  public snapshot(depth: number = 20): any {
    try { return JSON.parse(native.snapshot(this.orderbookName, depth)); }
    catch { return {}; }
  }
  public stats(): any {
    try { return JSON.parse(native.stats(this.orderbookName)); }
    catch { return {}; }
  }

  private async newChannel(
      tradeInfo: ITradeInfo,
      unfilled: TOrder
    ): Promise<IResultChannelSwap> {
      try {
        const buyerSocketId = tradeInfo.buyer.socketId;
        const sellerSocketId = tradeInfo.seller.socketId;

        const buyerSocket = socketManager.getSocketById(buyerSocketId) as Websocket;
        const sellerSocket = socketManager.getSocketById(sellerSocketId) as Websocket;

        if (!buyerSocket || !sellerSocket) {
          throw new Error("One of the sockets is not available");
        }

        const channel = new ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
        const channelRes = await channel.onReady();
        if (channelRes.error || !channelRes.data) return channelRes;

        const historyTrade: IHistoryTrade = {
          txid: channelRes.data.txid,
          time: Date.now(),
          ...tradeInfo,
        };
        this.saveToHistory(historyTrade);
        return channelRes;
      } catch (error: any) {
        return { error: error.message };
      }
    }

    private async processSubmitResult(
      symbol: string,
      order: TOrder,                        // the taker (incoming) order
      res: {
        transactions?: Array<{ price: number; quantity: number; transaction_id: string; maker?: boolean }>;
        maker_slices?: Array<{ price: number; quantity: number; maker_order_id: string; taker_order_id: string; maker: true }>;
        filled_order_ids?: string[];
        executed_qty?: number;
        remaining_qty?: number;
        is_complete?: boolean;
      }
    ) {
      const takerSide = order.side.toUpperCase() as "BUY" | "SELL";
      const makerSide = opposite(takerSide);
      const takerSocketId = order.socket_id!;   // required for swaps

      // 1) Maker executions (each slice ties to a concrete maker order id)
      for (const m of res.maker_slices || []) {
        const makerSocketId = ownerOf(m.maker_order_id);
        if (!makerSocketId) {
          console.warn("[exec] maker socket not found for", m.maker_order_id);
          continue;
        }

        // Build a minimal trade info for ChannelSwap
        const tradeInfo: ITradeInfo = {
          symbol,
          price: m.price,                // float (e.g., 1000.0)
          quantity: m.quantity,          // integer units
          buyer:  takerSide === "BUY"  ? { socketId: takerSocketId } : { socketId: makerSocketId },
          seller: takerSide === "SELL" ? { socketId: takerSocketId } : { socketId: makerSocketId },
          // Optional flags/metadata your protocol needs:
          maker: true,
          side_taker: takerSide,
          maker_order_id: m.maker_order_id,
          taker_order_id: m.taker_order_id,
          txid_hint: undefined,
        };

        // Fan-out execution events if you already do that:
        this.sendTo(makerSocketId, { event: "execution", data: { ...tradeInfo, party: "maker" } });
        this.sendTo(takerSocketId, { event: "execution", data: { ...tradeInfo, party: "taker" } });

        // Start the channel swap for this maker slice
        await this.newChannel(tradeInfo, order);
      }

      // 2) Taker-view transactions (inform taker; maker already got a slice)
      for (const tx of res.transactions || []) {
        const execTaker = {
          symbol,
          price: tx.price,               // float
          quantity: tx.quantity,
          maker: false,
          side_taker: takerSide,
          txid: tx.transaction_id,
        };
        this.sendTo(takerSocketId, { event: "execution", data: execTaker });
      }

      // 3) Cleanup fully-filled makers
      for (const id of res.filled_order_ids || []) {
        forgetOwner(id);
      }

      // 4) If the taker left a residual on book (shouldn’t happen for IOC), you may
      //    add bookkeeping here; Rust already re-posts remaining when not complete.
    }

}
