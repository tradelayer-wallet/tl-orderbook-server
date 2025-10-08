import {
  EOrderAction,
  EOrderType,
  IFuturesOrderProps,
  IHistoryTrade,
  ISpotOrderProps,
  ITradeInfo,
  TOrder,
} from "../../utils/types/orderbook.types";
import { IResult, IResultChannelSwap } from "../../utils/types/mix.types";
import { safeNumber, saveLog, updateOrderLog } from "../../utils/pure/mix.pure";
import { socketManager } from "../socket"; // instance with getSocketById(...), broadcastToAll, broadcastToMarket
import { ChannelSwap } from "../channel-swap/channel-swap.class";
import { TFilter } from "../../utils/types/markets.types";
import { orderbookManager } from ".";
import { EmitEvents } from "../socket/events";
import { readdirSync, readFileSync } from "fs";
import { Websocket } from "hyper-express";

// Native N-API (Rust)
const native = require("../../../rust/matcher-core/matcher_core.node");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeOrder(o: TOrder) {
  // Map your TOrder -> JsOrder expected by Rust
  const side = (o.action as string).toUpperCase(); // BUY | SELL from EOrderAction
  const price = (o.props as any).price ?? 0;
  let amount = (o.props as any).amount ?? 0;

    // ✅ SPOT-only amount scaling so core doesn't see 0
  if (o.type === EOrderType.SPOT) {
    amount = Math.round(amount * QTY_SCALE_SPOT);
  }

  return {
    uuid: o.uuid,
    side,
    price,
    amount,
    socket_id: o.socket_id || null,
  };
}

function normalizeBookKey(p1: number, p2: number): string {
  return p1 < p2 ? `${p1}-${p2}` : `${p2}-${p1}`;
}

const QTY_SCALE_SPOT = 1e8

/* ------------------------------------------------------------------ */
/* Orderbook                                                          */
/* ------------------------------------------------------------------ */

export class Orderbook {
  private _type: EOrderType;
  private _orders: TOrder[] = [];
  private _historyTrades: IHistoryTrade[] = [];
  private props: ISpotOrderProps | IFuturesOrderProps = null;
    private lastSnapTs = 0;
    private snapMinIntervalMs = 75; // small debounce for spammy clients
    private lastChecksum = "";
  // quick index: uuid -> order (to build ITradeInfo for maker slices)
  private byUuid = new Map<string, TOrder>();

  constructor(firstOrder: TOrder) {
    this._type = firstOrder.type;
    this.addProps(firstOrder);

    // Create native book for this market
    try {
      native.createBook(this.orderbookName);
    } catch (_) {}

    // Seed with first order (no fanout)
    this.addOrder(firstOrder, /* noTrades */ true);
    this.addExistingTradesHistory();
  }

  private isSpot(): boolean {
    return this._type === EOrderType.SPOT;
  }

    private downscaleResult(res: any) {
      if (!this.isSpot() || !res) return res;
      const scale = QTY_SCALE_SPOT;

      const fixQty = (x: any) => (typeof x === "number" ? x / scale : x);

      if (Array.isArray(res)) {
        return res.map(r => ({
          ...r,
          executed_qty: fixQty(r.executed_qty),
          remaining_qty: fixQty(r.remaining_qty),
          transactions: (r.transactions || []).map((t: any) => ({
            ...t,
            quantity: fixQty(t.quantity),
          })),
        }));
      } else {
        return {
          ...res,
          executed_qty: fixQty(res.executed_qty),
          remaining_qty: fixQty(res.remaining_qty),
          transactions: (res.transactions || []).map((t: any) => ({
            ...t,
            quantity: fixQty(t.quantity),
          })),
        };
      }
    }

  /* ------------------------- Legacy/compat ------------------------- */

  private get type(): EOrderType {
    return this._type;
  }

  get orderbookName(): string {
    if (this._type === EOrderType.SPOT) {
      const { id_desired, id_for_sale } = this.props as ISpotOrderProps;
      return `spot_${id_for_sale}_${id_desired}`;
    }
    if (this._type === EOrderType.FUTURES) {
      const { contract_id } = this.props as IFuturesOrderProps;
      return `futures-${contract_id}`;
    }
    return "unknown";
  }

  set orders(value: TOrder[]) {
    this._orders = value;
    this.byUuid.clear();
    for (const o of value) this.byUuid.set(o.uuid, o);
    this.broadcastSnapshot();
  }
  get orders(): TOrder[] {
    return this._orders;
  }

  get historyTrades() {
    return this._historyTrades;
  }

  private addExistingTradesHistory() {
    try {
      const data: IHistoryTrade[] = [];
      const existingFiles = readdirSync("logs");
      const names =
        this.type === EOrderType.SPOT &&
        "id_desired" in (this.props as any) &&
        "id_for_sale" in (this.props as any)
          ? [
              `spot_${(this.props as ISpotOrderProps).id_for_sale}-${
                (this.props as ISpotOrderProps).id_desired
              }`,
              `spot_${(this.props as ISpotOrderProps).id_desired}_${
                (this.props as ISpotOrderProps).id_for_sale
              }`,
            ]
          : this.type === EOrderType.FUTURES && "contract_id" in (this.props as any)
          ? [`futures-${(this.props as IFuturesOrderProps).contract_id}`]
          : null;

      const currentOBTradeFiles = existingFiles.filter((q) => {
        if (!q.startsWith("TRADE")) return false;
        if (!names) return false;
        return names.some((w) => q.includes(w));
      });

      currentOBTradeFiles.forEach((f) => {
        const stringData = readFileSync(`logs/${f}`, "utf8");
        const arrayData = stringData
          .split("\n")
          .slice(0, -1)
          .map((q) => JSON.parse(q) as IHistoryTrade);
        arrayData.forEach((d) => data.push(d));
      });

      this._historyTrades = data.slice(0, 2000);
      socketManager.broadcastToAll({ event: EmitEvents.UPDATE_ORDERS_REQUEST });
    } catch (error) {
      console.log({ error });
    }
  }

  private addProps(order: TOrder): IResult {
    try {
      if (this.props) throw new Error(`Props for this orderbook already exist`);

      const { type } = order;
      if (type === EOrderType.SPOT) {
        const { id_desired, id_for_sale } = order.props as ISpotOrderProps;
        this.props = { id_desired, id_for_sale } as ISpotOrderProps;
      }
      if (type === EOrderType.FUTURES) {
        const { contract_id } = order.props as IFuturesOrderProps;
        this.props = { contract_id } as IFuturesOrderProps;
      }
      return { data: true as any };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  private findByFilter (order: TOrder): IResult {
    try {
      if (this.props) throw new Error(`Props for this orderbook already exist`);

      const { type } = order;
      if (type === EOrderType.SPOT) {
        const { id_desired, id_for_sale } = order.props as ISpotOrderProps;
        this.props = { id_desired, id_for_sale } as ISpotOrderProps;
      }
      if (type === EOrderType.FUTURES) {
        const { contract_id } = order.props as IFuturesOrderProps;
        this.props = { contract_id } as IFuturesOrderProps;
      }
      return { data: true as any };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  public checkCompatible(order: TOrder): boolean {
    const p = order.props as any;
    if (order.type !== this.type) return false;

    if (order.type === EOrderType.SPOT) {
      const a = this.props as ISpotOrderProps;
      return (
        (p.id_desired === a.id_for_sale && p.id_for_sale === a.id_desired) ||
        (p.id_desired === a.id_desired && p.id_for_sale === a.id_for_sale)
      );
    }
    if (order.type === EOrderType.FUTURES) {
      const a = this.props as IFuturesOrderProps;
      return p.contract_id === a.contract_id;
    }
    return false;
  }

    public findByFilter(filter: any): boolean {
      if (!filter) return true;
      if (typeof filter === "string") {
        return this.orderbookName.toLowerCase().includes(filter.toLowerCase());
      }
      const typ = String(filter.type || filter.order_type || "").toUpperCase();
      if (typ === "SPOT") {
        const ft = Number(filter.first_token);
        const st = Number(filter.second_token);
        const p = this.props as ISpotOrderProps;
        return (
          (p.id_desired === ft && p.id_for_sale === st) ||
          (p.id_desired === st && p.id_for_sale === ft)
        );
      }
      if (typ === "FUTURES") {
        const cid = filter.contract_id ?? filter.cid ?? filter.symbol ?? filter.marketKey;
        const p = this.props as IFuturesOrderProps;
        return cid != null && `${p.contract_id}` === `${cid}`;
      }
      return false;
    }

  updatePlacedOrdersForSocketId(socketid: string) {
    try {
      const openedOrders = orderbookManager.getOrdersBySocketId(socketid);
      const orderHistory = orderbookManager.getOrdersHistory();
      // WAS: socketManager.sendTo(...)
      this.sendToSocketId(socketid, {
        event: EmitEvents.PLACED_ORDERS,
        openedOrders,
        orderHistory,
      });
    } catch {}
  }

  public removeOrder(uuid: string, _socket_id?: string) {
    const idx = this._orders.findIndex((o) => o.uuid === uuid);
    console.log('idx inside remove '+idx)
    if (idx >= 0) {
      const [removed] = this._orders.splice(idx, 1);
      this.byUuid.delete(uuid);
      try {
        if (native.cancel) native.cancel(this.orderbookName, uuid);
      } catch {}
      this.broadcastSnapshot();
      return { data: { removed } };
    }
    return { error: "order_not_found" };
  }

  /* ------------------------- IO / snapshots ------------------------ */

  
public snapshotNative(depth: number = 50) {
  try {
    const json = native.snapshot(this.orderbookName, depth);
    //console.log('snapshot of book '+json+' '+JSON.stringify(json))
    return typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return { version: 1, snapshot: { symbol: this.orderbookName, bids: [], asks: [] }, checksum: "" };
  }
}

// call this after addOrder / addOrdersBatch
private broadcastSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - this.lastSnapTs < this.snapMinIntervalMs) return;
  this.lastSnapTs = now;

  const marketKey = this.orderbookName;
  const nativeSnap = this.snapshotNative(50);

  // keep legacy arrays for old panels (may be empty) + authoritative native
  socketManager.broadcastToMarket(marketKey, {
    event: "orderbook-data",
    marketKey,
    orders: this._orders.filter(o => !o.lock),
    history: this._historyTrades,
    native: nativeSnap, // <-- FE should read this for bids/asks
  });

  socketManager.broadcastToAll({
    event: "orderbook-data",
    orders: this._orders.filter(o => !o.lock),
    history: this._historyTrades,
    native: nativeSnap,
  });
}

  /* --------------------------- Trading API ------------------------- */

  async addOrder(
    order: TOrder,
    noTrades: boolean = false
  ): Promise<IResult<{ order?: TOrder; trade?: ITradeInfo }>> {
    try {
      if (!this.checkCompatible(order))
        throw new Error(`Order mismatch current orderbook interface or type`);

      // Remember/refresh map entry immediately
      this.byUuid.set(order.uuid, order);
      //console.log('about to submit order to book '+JSON.stringify(order))
      // Submit to native
      const raw = native.submit(this.orderbookName, normalizeOrder(order));
      this.broadcastSnapshot();
      let res =
        typeof raw === "string" ? JSON.parse(raw) : (raw ?? { transactions: [] });
        res= this.downscaleResult(res)
      //console.log('back from rust engine '+JSON.stringify(res))
      // If not complete, reflect remaining on our local orders
      if (!res.is_complete && res.remaining_qty > 0) {
        const existingIdx = this._orders.findIndex((o) => o.uuid === order.uuid);
        if (existingIdx >= 0) {
          (this._orders[existingIdx].props as any).amount = res.remaining_qty;
        } else {
          const resting = { ...order };
          (resting.props as any).amount = res.remaining_qty;
          this._orders.push(resting);
        }
        this.byUuid.set(order.uuid, order);
      }

      if (!noTrades) {
        await this.processSubmitResult(order, res);
      }

      // Remove any fully filled makers from local state
      for (const id of res.filled_order_ids || []) {
        const idx = this._orders.findIndex((o) => o.uuid === id);
        if (idx >= 0) this._orders.splice(idx, 1);
        this.byUuid.delete(id);
      }

      // logs/hud
      if ((res.transactions || []).length === 0) {
        saveLog(this.orderbookName, "ORDER", order);
        this.updatePlacedOrdersForSocketId(order.socket_id);
      } else {
        // optionally: update per-order status via updateOrderLog(...)
      }

      this.broadcastSnapshot();
      return { data: { order } };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  async addOrdersBatch(
    orders: TOrder[],
    noTrades: boolean = false
  ): Promise<IResult<{ orders?: TOrder[]; trades?: ITradeInfo[] }>> {
    try {
      orders.forEach((o) => this.byUuid.set(o.uuid, o));

      const raw = native.submitBatch(
        this.orderbookName,
        orders.map(normalizeOrder)
      );

      let results: any[] = typeof raw === "string" ? JSON.parse(raw) : raw;

      if (this._type === EOrderType.SPOT) {
          const scale = 1e8;
          results = results.map(r => ({
            ...r,
            executed_qty: typeof r.executed_qty === "number" ? r.executed_qty / scale : r.executed_qty,
            remaining_qty: typeof r.remaining_qty === "number" ? r.remaining_qty / scale : r.remaining_qty,
            transactions: (r.transactions || []).map((t: any) => ({
              ...t,
              quantity: typeof t.quantity === "number" ? t.quantity / scale : t.quantity,
            })),
          }));
        }

      const tradesAll: ITradeInfo[] = [];

      // Update local book for resters
      results.forEach((r, i) => {
        if (!r.is_complete && r.remaining_qty > 0) {
          const src = orders[i];
          const idx = this._orders.findIndex((o) => o.uuid === src.uuid);
          if (idx >= 0) {
            (this._orders[idx].props as any).amount = r.remaining_qty;
          } else {
            const resting = { ...src };
            (resting.props as any).amount = r.remaining_qty;
            this._orders.push(resting);
          }
          this.byUuid.set(src.uuid, src);
        }
      });

      if (!noTrades) {
        for (let i = 0; i < results.length; i++) {
          const t = await this.processSubmitResult(orders[i], results[i]);
          if (t && t.length) tradesAll.push(...t);
        }
      }

      for (const r of results) {
        for (const id of r.filled_order_ids || []) {
          const idx = this._orders.findIndex((o) => o.uuid === id);
          if (idx >= 0) this._orders.splice(idx, 1);
          this.byUuid.delete(id);
        }
      }

      this.broadcastSnapshot();
      return { data: { orders, trades: tradesAll } };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  /* -------------------------- Trade plumbing ----------------------- */

  private async processSubmitResult(
    takerOrder: TOrder,
    res: {
      transactions?: Array<{
        price: number;
        quantity: number;
        transaction_id: string;
        maker?: boolean;
      }>;
      maker_slices?: Array<{
        price: number;
        quantity: number;
        maker_order_id: string;
        taker_order_id: string;
        maker: true;
      }>;
      filled_order_ids?: string[];
      executed_qty?: number;
      remaining_qty?: number;
      is_complete?: boolean;
    }
  ): Promise<ITradeInfo[] | void> {
    const out: ITradeInfo[] = [];
    const isTakerBuy = takerOrder.action === EOrderAction.BUY;

    // Per-slice maker attribution (from Rust)
    for (const m of res.maker_slices || []) {
      const makerOrder = this.byUuid.get(m.maker_order_id);
      if (!makerOrder) continue;

      const makerIsSeller = makerOrder.action === EOrderAction.SELL;
      const price = m.price;
      const qty = m.quantity;

      // Build trade props by type (use `any` to match your app’s runtime shape)
      let tradeProps: any;
      if (takerOrder.type === EOrderType.FUTURES) {
        const src =
          (takerOrder.props as IFuturesOrderProps) ||
          (makerOrder.props as IFuturesOrderProps);
        tradeProps = {
          amount: qty,
          contract_id: src.contract_id,
          price,
          initMargin: (src as any).initMargin,
          collateral: (src as any).collateral,
          sellerIsMaker: makerIsSeller,
          transfer: (src as any).transfer,
        };
      } else {
        const takerSpot = (isTakerBuy ? takerOrder : makerOrder)
          .props as ISpotOrderProps;
        const idDesired =
          takerSpot.id_desired ??
          (makerOrder.props as ISpotOrderProps).id_desired;
        const idForSale =
          takerSpot.id_for_sale ??
          (makerOrder.props as ISpotOrderProps).id_for_sale;
        tradeProps = {
          propIdDesired: idDesired,
          propIdForSale: idForSale,
          amountDesired: qty,
          amountForSale: safeNumber(qty * price),
          sellerIsMaker: makerIsSeller,
          transfer: (takerSpot as any).transfer,
        };
      }

      // Build buyer/seller client infos
      const buyerOrder = isTakerBuy ? takerOrder : makerOrder;
      const sellerOrder = isTakerBuy ? makerOrder : takerOrder;

      const buyer = {
        socketId: buyerOrder.socket_id,
        keypair: buyerOrder.keypair,
        uuid: buyerOrder.uuid,
      };
      const seller = {
        socketId: sellerOrder.socket_id,
        keypair: sellerOrder.keypair,
        uuid: sellerOrder.uuid,
      };

      const tradeInfo: ITradeInfo = {
        type: takerOrder.type,
        buyer,
        seller,
        taker: takerOrder.socket_id,
        maker: makerOrder.socket_id,
        props: tradeProps,
      };

      // Emit execution (both sides)
      this.emitExecution(buyer.socketId, tradeInfo);
      this.emitExecution(seller.socketId, tradeInfo);

      // Start channel swap (legacy path)
      const ch = await this.newChannel(
        tradeInfo,
        this.cloneWithAmount(takerOrder, qty)
      );
      if (ch?.error) {
        console.warn("[channel error]", ch.error);
      }

      // Persist to history (saveToHistory is called inside newChannel after success)
      out.push(tradeInfo);
    }

    return out;
  }

  private emitExecution(socketId: string, tradeInfo: ITradeInfo) {
    // WAS: socketManager.sendTo(...)
    this.sendToSocketId(socketId, { event: "execution", data: tradeInfo });
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

      const channel = new ChannelSwap(
        buyerSocket,
        sellerSocket,
        tradeInfo,
        unfilled
      );
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

  private cloneWithAmount(order: TOrder, amount: number): TOrder {
    if (order.type === EOrderType.SPOT) {
      const p = order.props as ISpotOrderProps;
      return {
        ...order,
        props: { ...p, amount: safeNumber(amount) } as ISpotOrderProps,
      } as TOrder;
    } else {
      const p = order.props as IFuturesOrderProps;
      return {
        ...order,
        props: { ...p, amount: safeNumber(amount) } as IFuturesOrderProps,
      } as TOrder;
    }
  }

  private saveToHistory(historyTrade: IHistoryTrade) {
    this._historyTrades = [historyTrade, ...this.historyTrades.slice(0, 1999)];
    saveLog(this.orderbookName, "TRADE", historyTrade);
    socketManager.broadcastToAll({ event: EmitEvents.UPDATE_ORDERS_REQUEST });
  }

  /* -------------------------- Socket sends ------------------------- */

  private sendToSocketId(socketId: string, payload: any) {
    try {
      const ws = socketManager.getSocketById(socketId) as Websocket | undefined;
      if (ws && (ws as any).readyState === 1 /* OPEN */) {
        ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      }
    } catch (e) {
      // ignore
    }
  }
}
