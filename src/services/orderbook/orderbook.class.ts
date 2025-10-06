// src/services/orderbook/orderbook.class.ts

import { Websocket } from "hyper-express";
import { ChannelSwap } from "../channel-swap/channel-swap.class";        // <-- check path
import { SocketManager } from "../socket/manager.class";                 // <-- check path

// N-API binding
const core = require("../../../rust/matcher-core/matcher_core.node");    // <-- check path

// === Use your real app types so manager/socket compile ===
import type {
  TOrder,            
  ITradeInfo,         
  IHistoryTrade
} from "../../utils/types/orderbook.types";  

type SideStr = "BUY" | "SELL";

// Normalize to the JsOrder expected by the Rust layer
function normalizeOrder(o: TOrder) {
  return {
    uuid: o.uuid,
    side: (o.side as string).toUpperCase(),  // "BUY"/"SELL"
    price: o.price,
    amount: o.amount,
    socket_id: (o as any).socket_id ?? null,
  };
}

// Access a socket manager instance
const socketManager: SocketManager =
  (SocketManager as any).getInstance?.() ?? new SocketManager();

export class Orderbook {
  public readonly orderbookName: string;

  // Legacy fields expected by other code
  public orders: TOrder[] = [];
  public historyTrades: IHistoryTrade[] = [];

  // Internal owner map (maker routing)
  private ownerByOrderId = new Map<string, string>();

  // --- Constructors: accept symbol OR firstOrder (legacy) ---
  constructor(symbolOrOrder: string | TOrder) {
    if (typeof symbolOrOrder === "string") {
      this.orderbookName = symbolOrOrder;
    } else {
      const firstOrder = symbolOrOrder as TOrder;
      const sym = (firstOrder as any).symbol || (firstOrder as any).pair || "UNKNOWN";
      this.orderbookName = sym;
      // Seed book with the first order without emitting trades
      // (Manager expects `orderbook.orders[0]` right after creation)
      this.addOrder(firstOrder, /* noTrades */ true).catch(() => {});
    }

    try {
      if (typeof core.createBook === "function") core.createBook(this.orderbookName);
    } catch (e) {
      console.warn("[orderbook] createBook warn:", e);
    }
  }

  /* ===========================
        Legacy/compat API
  =========================== */

  // Manager calls this after constructing with firstOrder
  public updatePlacedOrdersForSocketId(socketId?: string) {
    // no-op placeholder to keep behavior; your old impl probably cached per-socket views
    return;
  }

  // Used by manager to find an OB that matches this order
  public checkCompatible(order: TOrder): boolean {
    const sym = (order as any).symbol || (order as any).pair || "UNKNOWN";
    return sym === this.orderbookName;
  }

  // Used by socket manager to filter a specific book
  public findByFilter(filter: { symbol?: string; [k: string]: any }): boolean {
    return !filter?.symbol || filter.symbol === this.orderbookName;
  }

  // Legacy cancel (soft remove + TODO native cancel)
  public removeOrder(uuid: string, socket_id?: string) {
    // TODO: wire to native cancel if/when available
    const idx = this.orders.findIndex(o => o.uuid === uuid);
    if (idx >= 0) {
      const [removed] = this.orders.splice(idx, 1);
      this.ownerByOrderId.delete(uuid);
      return { data: { removed } };
    }
    return { error: "order_not_found" };
  }

  /* ===========================
        Public trading API
  =========================== */

  // add one; optionally suppress fan-out/swaps
  public async addOrder(order: TOrder, noTrades: boolean = false) {
    // Remember owner in case this order rests
    if ((order as any)?.uuid && (order as any)?.socket_id) {
      this.rememberOwner((order as any).uuid, (order as any).socket_id);
    }

    const raw = core.submit(this.orderbookName, normalizeOrder(order));
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;

    // If it rests, reflect in local `orders`
    if (!res.is_complete && res.remaining_qty > 0) {
      const resting: TOrder = {
        ...order,
        amount: res.remaining_qty,
      } as TOrder;
      // Replace existing by uuid or push
      const i = this.orders.findIndex(o => o.uuid === resting.uuid);
      if (i >= 0) this.orders[i] = resting; else this.orders.push(resting);
    }

    if (!noTrades) {
      await this.processSubmitResult(this.orderbookName, order, res).catch((e: any) =>
        console.error("[processSubmitResult]", e)
      );
    }
    return res;
  }

  // add many; optionally suppress fan-out/swaps
  public async addOrdersBatch(orders: TOrder[], noTrades: boolean = false) {
    for (const o of orders) {
      if ((o as any)?.uuid && (o as any)?.socket_id) {
        this.rememberOwner((o as any).uuid, (o as any).socket_id);
      }
    }

    const raw = core.submitBatch(this.orderbookName, orders.map(normalizeOrder));
    const results: any[] = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Update local orders for any that rested
    results.forEach((res, i) => {
      if (!res.is_complete && res.remaining_qty > 0) {
        const src = orders[i];
        const resting: TOrder = { ...src, amount: res.remaining_qty } as TOrder;
        const idx = this.orders.findIndex(o => o.uuid === resting.uuid);
        if (idx >= 0) this.orders[idx] = resting; else this.orders.push(resting);
      }
    });

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

  /* ===========================
        Internals
  =========================== */

  private rememberOwner(orderId: string, socketId?: string) {
    if (orderId && socketId) this.ownerByOrderId.set(orderId, socketId);
  }
  private forgetOwner(orderId: string) {
    if (orderId) this.ownerByOrderId.delete(orderId);
  }
  private ownerOf(orderId: string): string | undefined {
    return this.ownerByOrderId.get(orderId);
  }
  private opposite(side: SideStr): SideStr {
    return side === "BUY" ? "SELL" : "BUY";
  }

  private sendTo(socketId: string, payload: any) {
    try {
      const ws = (socketManager as any).getSocketById?.(socketId) as Websocket | undefined;
      if (ws && (ws as any).readyState === 1 /* OPEN */) {
        ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      }
    } catch (e) {
      console.warn("[orderbook.sendTo] error", e);
    }
  }

  private saveToHistory(trade: IHistoryTrade) {
    this.historyTrades.push(trade);
  }

  // Turn the native submit() result into client execs + channel swaps
  private async processSubmitResult(
    symbol: string,
    order: TOrder,
    res: {
      transactions?: Array<{ price: number; quantity: number; transaction_id: string; maker?: boolean }>;
      maker_slices?: Array<{ price: number; quantity: number; maker_order_id: string; taker_order_id: string; maker: true }>;
      filled_order_ids?: string[];
      executed_qty?: number;
      remaining_qty?: number;
      is_complete?: boolean;
    }
  ) {
    const takerSide = ((order as any).side || "").toUpperCase() as SideStr;
    const takerSocketId = (order as any).socket_id as string;

    // 1) maker slices (definitive maker attribution from Rust)
    for (const m of res.maker_slices || []) {
      const makerSocketId = this.ownerOf(m.maker_order_id);
      if (!makerSocketId) {
        console.warn("[exec] maker socket not found for", m.maker_order_id);
        continue;
      }

      // Build ITradeInfo expected by ChannelSwap in your app (add required fields)
      const tradeInfo: ITradeInfo = {
        symbol,
        price: m.price,
        quantity: m.quantity,
        buyer:  takerSide === "BUY" ? { socketId: takerSocketId } : { socketId: makerSocketId },
        seller: takerSide === "SELL" ? { socketId: takerSocketId } : { socketId: makerSocketId },
        // Likely-required fields in your codebase:
        taker: { socketId: takerSocketId } as any,    // <-- fill properly if your type demands more
        props: {} as any,                             // <-- pass through any protocol props if needed
        type: "swap" as any,                          // <-- set to your enum/literal
        // helpful flags/ids
        maker: true as any,
        side_taker: takerSide as any,
        maker_order_id: m.maker_order_id as any,
        taker_order_id: m.taker_order_id as any,
      } as ITradeInfo;

      // Emit execution to each side
      this.sendTo(makerSocketId, { event: "execution", data: { ...tradeInfo, party: "maker" } });
      this.sendTo(takerSocketId, { event: "execution", data: { ...tradeInfo, party: "taker" } });

      // Start settlement channel
      await this.newChannel(tradeInfo, order);
    }

    // 2) taker-facing transactions (maker already handled)
    for (const tx of res.transactions || []) {
      const execTaker = {
        symbol,
        price: tx.price,
        quantity: tx.quantity,
        maker: false,
        side_taker: takerSide,
        txid: tx.transaction_id,
      };
      this.sendTo(takerSocketId, { event: "execution", data: execTaker });
    }

    // 3) GC fully-filled makers
    for (const id of res.filled_order_ids || []) {
      this.forgetOwner(id);
      // also remove from local orders list if present
      const idx = this.orders.findIndex(o => o.uuid === id);
      if (idx >= 0) this.orders.splice(idx, 1);
    }
  }

  // Your requested orchestration; keeps your exact flow
  private async newChannel(
    tradeInfo: ITradeInfo,
    unfilled: TOrder
  ): Promise<IResultChannelSwap> {
    try {
      const buyerSocketId = (tradeInfo as any).buyer.socketId;
      const sellerSocketId = (tradeInfo as any).seller.socketId;

      const buyerSocket = (socketManager as any).getSocketById(buyerSocketId) as Websocket;
      const sellerSocket = (socketManager as any).getSocketById(sellerSocketId) as Websocket;

      if (!buyerSocket || !sellerSocket) {
        throw new Error("One of the sockets is not available");
      }

      const channel = new ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
      const channelRes = await channel.onReady();
      if ((channelRes as any).error || !(channelRes as any).data) return channelRes;

      const historyTrade: IHistoryTrade = {
        txid: (channelRes as any).data.txid,
        time: Date.now(),
        ...tradeInfo,
      };
      this.saveToHistory(historyTrade);
      return channelRes;
    } catch (error: any) {
      return { error: error.message };
    }
  }
}
