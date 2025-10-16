// ---------- imports ----------
import HyperExpress from 'hyper-express';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { native, registerNativeSinks, JsOrder, Exec } from '../../native';
import { ChannelSwap } from "../channel-swap/channel-swap.class";

import {
  ITradeInfo,
  TOrder,
  EOrderType,
  EOrderAction,
  ISpotOrderProps,
  IFuturesOrderProps,
} from '../../utils/types/orderbook.types';

type WS = HyperExpress.Websocket;
type UUID = string;

export type OrderAction = 'BUY' | 'SELL';
export type OrderTypeKind = 'SPOT' | 'FUTURES';

const toEOrderType = (t: unknown): EOrderType => {
  if (t === EOrderType.FUTURES || t === 'FUTURES') return EOrderType.FUTURES;
  return EOrderType.SPOT;
};

export interface IResult<T> { data?: T; error?: string }
export interface IResultChannelSwap extends IResult<{ txid: string }> {}

export function safeNumber(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

interface IHistoryTrade extends ITradeInfo {
  txid: string;
  time: number;
}

type NormalizedOrder = {
  uuid: string;
  socketId: string;
  price: number;
  amount: number;
  side: 'BUY' | 'SELL';
  type?: 'SPOT' | 'FUTURES';
  action?: 'BUY' | 'SELL';
  props?: any;
  keypair?: any;
  error?: string;
};

const PRICE_SCALE = 100;   // engine ticks -> UI price
const QTY_SCALE   = 1e8;   // engine sats  -> UI amount

// Polyfill for queueMicrotask if needed
if (typeof (global as any).queueMicrotask !== 'function') {
  (global as any).queueMicrotask = (fn: () => void) => Promise.resolve().then(fn);
}



// --- helpers ---
// ---- exec/snapshot wiring (strict) ------------------------------------------

type WireSinks = {
  onExecs?: (symbol: string, execs: any[]) => void;
  onSnapshot?: (symbol: string, snapshot: any) => void;
};

const looksLikeJsonArray = (s: unknown) =>
  typeof s === 'string' && /^\s*\[/.test(s);

const parseArrayStrict = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (looksLikeJsonArray(v)) {
    return JSON.parse(v as string);
  }
  throw new Error(`[exec] expected array (or JSON string array), got ${typeof v}`);
};

let _loggedProbeOnce = false;

/**
 * Strictly wire native (preferred) or shim (fallback) exec/snapshot sinks.
 * Fails loud on wrong types to surface mis-wiring immediately.
 */
export const wireExecSinksStrict = (
  nativeObj: any,
  registerNativeSinksFn: (s: WireSinks) => void,
  sinks: WireSinks
) => {
  const { setExecSink, setSnapshotSink, nativeBuildId } = nativeObj ?? {};
  if (typeof nativeBuildId === 'function') {
    try { console.log('[native build]', nativeBuildId()); } catch {}
  }

  const hasNativeExecs = typeof setExecSink === 'function';

  // Prefer native
  if (hasNativeExecs && typeof sinks.onExecs === 'function') {
    setExecSink((symbol: string, execsJson: string) => {
      // legacy probe tolerance still OK but should never hit now
      // (kept for safety; delete if you want)
      if ((symbol as any) == null && typeof execsJson === 'string') {
        if (!_loggedProbeOnce) {
          console.warn('[exec] (null, symbol) probe; ignoring once:', execsJson);
          _loggedProbeOnce = true;
        }
        return;
      }

      if (typeof symbol !== 'string') {
        throw new Error(`[exec] expected symbol:string, got ${typeof symbol}`);
      }

      try {
        const arr = JSON.parse(execsJson);
        if (Array.isArray(arr) && arr.length) {
          sinks.onExecs!(symbol, arr);
        }
      } catch (e) {
        console.error('[exec parse error]', e);
      }
    });
  }

  if (typeof setSnapshotSink === 'function' && typeof sinks.onSnapshot === 'function') {
    setSnapshotSink((symbol: unknown, snapshot: unknown) => {
      if (typeof symbol !== 'string') {
        throw new Error(`[snapshot] expected symbol:string, got ${typeof symbol}`);
      }
      const obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      queueMicrotask(() => sinks.onSnapshot!(symbol, obj));
    });
    console.log('[sinks] addon snapshot wired (STRICT)');
  }

  // Fallback shim only if native exec sink is missing
  if (!hasNativeExecs) {
    registerNativeSinksFn({
      onExecs: (symbol: unknown, execs: unknown) => {
        if (typeof symbol !== 'string') {
          throw new Error(`[shim exec] expected symbol:string, got ${typeof symbol}`);
        }
        const arr = parseArrayStrict(execs);
        queueMicrotask(() => sinks.onExecs?.(symbol, arr));
      },
      onSnapshot: (symbol: unknown, snapshot: unknown) => {
        if (typeof symbol !== 'string') {
          throw new Error(`[shim snap] expected symbol:string, got ${typeof symbol}`);
        }
        const obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
        queueMicrotask(() => sinks.onSnapshot?.(symbol, obj));
      },
    });
    console.log('[sinks] shim exec/snapshot wired (STRICT)');
  }
};


function parseMaybeJson<T = any>(x: unknown, fallback: T): T {
  if (x == null) return fallback;
  if (typeof x !== 'string') return x as T;
  try { return JSON.parse(x) as T; } catch { return fallback; }
}

function normalizeSnapshotToRows(snapObj: any, PRICE_SCALE = 100, QTY_SCALE = 1e8) {
  const snap = snapObj?.snapshot ?? snapObj;
  if (!snap || (!Array.isArray(snap.bids) && !Array.isArray(snap.asks))) return [];

  const rows: Array<{ price:number; amount:number; side:'BUY'|'SELL'; isBuy:boolean }> = [];

  for (const b of (snap.bids ?? [])) {
    rows.push({
      price: PRICE_SCALE ? (Number(b.price) / PRICE_SCALE) : Number(b.price),
      amount: (Number(b.amount ?? b.visible_quantity ?? 0)) / QTY_SCALE,
      side: 'BUY',
      isBuy: true,
    });
  }

  for (const a of (snap.asks ?? [])) {
    rows.push({
      price: PRICE_SCALE ? (Number(a.price) / PRICE_SCALE) : Number(a.price),
      amount: (Number(a.amount ?? a.visible_quantity ?? 0)) / QTY_SCALE,
      side: 'SELL',
      isBuy: false,
    });
  }
  return rows;
}

export class SocketManager {
  private _liveSessions = new Map<string, WS>();
  private _marketSubs = new Map<string, Set<string>>();
  private _sessionSubs = new Map<string, Set<string>>();

  private _dirty = new Set<string>();
  private _flushing = false;
  private _coalesceMs = 50;
  private _depth = 40;

  private _recentClose = new Map<string, Map<string, number>>();
  private _uuidToMarket = new Map<string, string>();
  private _byUuid = new Map<string, { market: string; price?: number; quantity?: number }>();

  private _tickHandle: NodeJS.Timeout | null = null;
  private _lastNativeSnap = new Map<string, any>(); // marketKey -> latest snapshot

  constructor() {
    // periodic broadcaster
    this._tickHandle = setInterval(() => this.flushOrderbookData(), this._coalesceMs);

    // wire sinks (native preferred, shim fallback)
    wireExecSinksStrict(native as any, registerNativeSinks, {
      onExecs: (symbol, execs) => this._handleExecs(symbol, execs),
      onSnapshot: (symbol, snapshot) => {
        this._lastNativeSnap.set(symbol, snapshot);
        this._dirty.add(symbol);
      }
    });
  }
    
  // Register a socket with its id
  add(id: string, ws: WS) {
    this._liveSessions.set(id, ws);
  }

  // Lookup by id
  get(id: string): WS | undefined {
    return this._liveSessions.get(id);
  }

  // Remove by id
  remove(id: string) {
    this._liveSessions.delete(id);
  }

  has(id: string): boolean {
    return this._liveSessions.has(id);
  }

  size(): number {
    return this._liveSessions.size;
  }

  private flushOrderbookData() {
     if (this._dirty.size === 0) return;
     const markets = Array.from(this._dirty);
     this._dirty.clear();
     for (const mk of markets) {
       const native = this._lastNativeSnap.get(mk);
       if (!native) continue;
       this.broadcastToMarket(mk, {
         event: EmitEvents.ORDERBOOK_DATA,
         marketKey: mk,
         native,
       });
     }
  }

  spotKeyFromIds(a?: any, b?: any): string | null {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const x = Number(a), y = Number(b);
      const base = Math.min(x, y);
      const quote = Math.max(x, y);
      return `${base}-${quote}`;            // canonical internal key
    }

  futKey(contractId?: any, expiry?: any): string | null {
    if (!contractId && !expiry) return null;
    const cid = String(contractId ?? '');
    const exp = expiry == null ? 'perp' : String(expiry);
    return `${cid}-${exp}`;
  }

  // minimal stub so the optional call compiles; wire to real storage later
  private saveToHistory(t: IHistoryTrade): void {
    // e.g., push to an in-memory array or forward to persistence
    // (left intentionally no-op for now)
  }

  // === Public API expected by index.ts ===
  handleOpen = (ws: WS) => {
    const id = this.generateUniqueId();
    (ws as any).id = id;
    (ws as any)._markets = new Set<string>();
    this._liveSessions.set(id, ws);

    ws.on('message', (m) => this.handleMessage(ws, m));
    ws.on('close', () => this.handleClose(ws));

    // initial hello (client will request market snapshots it cares about)
    ws.send(JSON.stringify({ event: 'connected', id }));
    // (optional) send a small hint to prompt the client to request a market

    console.log(`[SM] OPEN ${id}, live=${this._liveSessions.size}`);
  };

  // === Event handlers ===
  private async handleMessage(ws: WS, message: ArrayBuffer | string) {
    let data: any;
    try {
      data = JSON.parse(
        typeof message === 'string'
          ? message
          : Buffer.from(message).toString()
      );
    } catch (e) {
      console.error('[SM] Failed to parse WS message', e, message);
      return;
    }
    console.log('incoming message '+JSON.stringify(data))
    switch (data.event) {
      case OnEvents.NEW_ORDER: {
        await this.handleNewOrder(ws, data);
        break;
      }
      case OnEvents.UPDATE_ORDERBOOK: {
        this.handleUpdateOrderbook(ws, data);
        break;
      }
      case OnEvents.CLOSE_ORDER:
      case 'close-order': {
        const uuid = String(data.orderUUID || data.uuid || '');
        if (this._seenClose(ws, uuid)) break; // drop duplicate spam
        this.handleCloseOrder(ws, data);
        break;
      }
      case OnEvents.MANY_ORDERS: {
        await this.handleManyOrders(ws, data);
        break;
      }
      case OnEvents.AMEND_ORDER: {
      const uuid  = String(data.orderUUID || data.orderUuid || data.uuid || '');
      const mk    = this.resolveMarket(data);
      const newQty = data.newAmount ?? data.newQty;
      const newPx  = data.newPrice;

      if (!uuid || !mk) {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: !uuid ? 'Missing orderUUID' : 'Missing marketKey'
        }));
        break;
      }

      try {
        native.init_market?.(mk);
        // pass undefined for fields you aren't changing
        native.edit(
          mk,
          uuid,
          newQty != null ? Number(newQty) : undefined,
          newPx  != null ? Number(newPx)  : undefined
        );

        // optional ack
        ws.send(JSON.stringify({
          event: 'amended',
          orderUuid: uuid,
          marketKey: mk,
          newQty,
          newPrice: newPx
        }));

        // nudge clients to refresh the book / opened orders
        this.broadcastToMarket(mk, { event: EmitEvents.UPDATE_ORDERS_REQUEST, marketKey: mk });
      } catch (e: any) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: e?.message || 'amend failed' }));
      }
      break;
    }

      case OnEvents.ORDERBOOK_JOIN: {
        const mk = this.resolveMarket(data)
        if (mk) this.subscribeMarket((ws as any).id, mk, ws);
        break;
      }
      case OnEvents.ORDERBOOK_LEAVE: {
        const mk = String(data.marketKey ?? '') || '';
        if (mk) this.unsubscribeMarket((ws as any).id, mk);
        break;
      }
      case OnEvents.DISCONNECT: {
        this.sweepOrders((ws as any).id, 'client-disconnect');
        ws.close();
        break;
      }
      default: {
        console.log(`[SM] Unknown event type: ${data.event}`);
      }
    }
  }

  private async handleNewOrder(ws: HyperExpress.Websocket, data: any){
    //  1. Basic guards
    if (!data.isLimitOrder) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: 'Market Orders Not allowed'
      }));
      return;
    }

    // --- FUTURES normalization ---
    if (data?.type === 'FUTURES' && data?.props) {
      if (data.props.contractId && !data.props.contract_id) {
        data.props.contract_id = data.props.contractId;
        delete data.props.contractId;
      }
    }

    // --- SPOT normalization ---
    if (data?.type === 'SPOT' && data?.props) {
      const f = data.props.id_for_sale;
      const d = data.props.id_desired;
      if (f == null || d == null) {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Missing property IDs'
        }));
        return;
      }
      const baseId  = Math.min(f, d);
      const quoteId = Math.max(f, d);
      if (f === baseId && d === quoteId) data.props.side = 'BUY';
      else if (f === quoteId && d === baseId) data.props.side = 'SELL';
      else {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Invalid property ID pair'
        }));
        return;
      }
    }

    // 🧭 2. Resolve market
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(data);
    this.ensureSocketMarketIndex(sid, market);
    if (!market) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: 'Missing marketKey'
      }));
      return;
    }

    // ⚙️ 3. Normalize & ACK
    const order = this.normalizeOrder(data, sid) as NormalizedOrder;
    if (order.error) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: order.error }));
      return;
    }
    console.log('order before sub '+JSON.stringify(order)+' and after toJs '+JSON.stringify(this.toJsOrder(order)))
    try {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.SAVED,
        orderUuid: order.uuid
      }));

      // 🔧 4. Submit to native engine
      native.submit(market, this.toJsOrder(order));

      // 🧩 5. Immediate placed-orders tray
      console.log('about to call orders ' + sid + ' ' + market);
      try {
        const openedRaw = (native as any).get_open_orders_by_socket?.(sid, market);
        console.log('fetched orders ' + JSON.stringify(openedRaw));

        const historyRaw = (native as any).getOrderHistoryBySocket?.(sid, market);
        console.log('order history ' + JSON.stringify(historyRaw));

        const opened = typeof openedRaw === 'string'
          ? JSON.parse(openedRaw)
          : (Array.isArray(openedRaw) ? openedRaw : []);

        const orderHistory = typeof historyRaw === 'string'
          ? JSON.parse(historyRaw)
          : (Array.isArray(historyRaw) ? historyRaw : []);

        ws.send(JSON.stringify({
          event: EmitEvents.PLACED_ORDERS,
          openedOrders: opened,
          orderHistory
        }));
      } catch (err) {
        console.warn('[placed-orders err]', err);
      }

      // 📡 6. Broadcast snapshot to all subs
      
      const snapRaw = (native as any).snapshot?.(market);

      console.log('market snapshot ' + JSON.stringify(snapRaw));

      const snapObj = typeof snapRaw === 'string'
        ? JSON.parse(snapRaw)
        : (snapRaw ?? null);

      // OPTIONAL: price scale normalization (engine ticks -> UI units)
      // If your engine stores price=100 but UI expects 1.00, set PRICE_SCALE accordingly.
      // Derive from market metadata if you have it.
      const normalized =
          snapObj && snapObj.snapshot
            ? {
                symbol: snapObj.snapshot.symbol,
                timestamp: snapObj.snapshot.timestamp,
                bids: (snapObj.snapshot.bids ?? []).map((b: any) => ({
                  price: PRICE_SCALE ? b.price / PRICE_SCALE : b.price,
                  amount: (b.visible_quantity ?? 0) / QTY_SCALE,  
                  count: b.order_count,
                })),
                asks: (snapObj.snapshot.asks ?? []).map((a: any) => ({
                  price: PRICE_SCALE ? a.price / PRICE_SCALE : a.price,
                  amount: (a.visible_quantity ?? 0) / QTY_SCALE,   
                  count: a.order_count,
                })),
                checksum: snapObj.checksum,
              }
            : null;

          this.broadcastToMarket(market,{
            event: EmitEvents.ORDERBOOK_DATA,
            orders: normalized,
            isDelta: false,
            history: 0,
          });

      // Send a real object, not a string
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        orders: normalized,       // or snapObj if you don't want to reshape/scale
        isDelta: false,
        history: 0,
      }));
    } catch (e: any) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: e?.message || 'submit failed'
      }));
    }
  }

  private async handleManyOrders(ws: WS, data: any) {
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(data);
    this.ensureSocketMarketIndex(sid, market);
    if (!market) {
      ws.send(
        JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Missing marketKey',
        })
      );
      return;
    }

    const rawOrders: any[] = Array.isArray(data.orders) ? data.orders : [];
    const normalized = rawOrders.map(
      (o) => this.normalizeOrder(o, sid) as NormalizedOrder
    );


    try {
      // give per-order ACKs (client expects this)
      for (const o of normalized) {
        ws.send(
          JSON.stringify({ event: OrderEmitEvents.SAVED, orderUuid: o.uuid })
        );
      }

      const jsOrders = normalized.map((o) => this.toJsOrder(o));
      // If you have native.submit_batch you can use it; otherwise loop:
      for (const o of jsOrders) native.submit(market, o);

      this.broadcastToMarket(market, {
        event: EmitEvents.UPDATE_ORDERS_REQUEST,
      });
    } catch (e: any) {
      ws.send(
        JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: e?.message || 'batch submit failed',
        })
      );
    }
  }

  private handleCloseOrder(ws: WS, data: any) {
    const uuid = String(data.orderUUID || data.uuid || '');
    if (!uuid) return;

    const sid    = (ws as any).id as string;
    const market = this.resolveMarket(data);
    console.log('uuid', uuid, market);
    this.ensureSocketMarketIndex(sid, market);

    if (!market) {
      console.warn('[close-order] missing marketKey for uuid', uuid);
      return;
    }

    try {
      // cancel on the engine
      (native as any).cancel?.(market, uuid);
    } catch (e) {
      console.warn('[close-order] cancel error', e);
    }


    setTimeout(() => {
      console.log('sending snapshot after cancel')
      try {
        this.sendOrderbookSnapshot(ws, market);
      } catch (e) {
        console.warn('[close-order] snapshot send error', e);
      }
    }, 1)
    // optionally re-broadcast fresh snapshot to this socket
    
    // fetch latest opened orders + history for THIS socket & market
    try {
      const openedRaw  = (native as any).get_open_orders_by_socket?.(sid, market);
      const historyRaw = (native as any).getOrderHistoryBySocket?.(sid, market);

      const opened = typeof openedRaw  === 'string'
        ? JSON.parse(openedRaw)
        : (Array.isArray(openedRaw) ? openedRaw : []);

      const orderHistory = typeof historyRaw === 'string'
        ? JSON.parse(historyRaw)
        : (Array.isArray(historyRaw) ? historyRaw : []);

      ws.send(JSON.stringify({
        event: EmitEvents.PLACED_ORDERS,
        openedOrders: opened,
        orderHistory,
      }));
    } catch (err) {
      console.warn('[close-order] post-cancel fetch/send err', err);
      ws.send(JSON.stringify({
        event: EmitEvents.PLACED_ORDERS,
        openedOrders: [],
        orderHistory: [],
      }));
    }
  }

  private handleUpdateOrderbook(ws: WS, data: any) {
    // accept: {marketKey}, or {filter:{marketKey}}, or {symbol}
    const mk = String(data.marketKey || data.symbol || '') || '';
    if (!mk) {
      ws.send(
        JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          orders: [],
          history: [],
        })
      );
      return;
    }
    this.sendOrderbookSnapshot(ws, mk);
  }
// === Native exec fanout ===
private async _handleExecs(
  marketKey: string,
  execs: Array<{
    price: number;
    quantity: number;
    maker_socketId?: string; maker_socket_id?: string;
    taker_socketId?: string; taker_socket_id?: string;
    maker_ext_uuid?: string;
    taker_ext_uuid?: string;
    side_of_taker?: 'BUY' | 'SELL'; sideOfTaker?: 'BUY' | 'SELL';
    props?: any;
    taker_keypair?: { address: string; pubkey: string };
    maker_keypair?: { address: string; pubkey: string };
  }>
) {
  // Normalize first so logs/use are consistent
  const normalized = (Array.isArray(execs) ? execs : []).map((raw: any) => {
    const makerSocketId = raw.maker_socketId ?? raw.maker_socket_id ?? null;
    const takerSocketId = raw.taker_socketId ?? raw.taker_socket_id ?? null;
    const makerUuid     = raw.maker_ext_uuid ?? '';
    const takerUuid     = raw.taker_ext_uuid ?? '';
    const sideOfTaker   = (raw.side_of_taker ?? raw.sideOfTaker ?? 'BUY') as 'BUY' | 'SELL';
    const price         = Number(raw.price) || 0;          // MATCH price
    const quantity      = Number(raw.quantity) || 0;
    const props         = raw.props ?? null;
    const takerKeypair  = raw.taker_keypair ?? raw.takerKeypair ?? null;
    const makerKeypair  = raw.maker_keypair ?? raw.makerKeypair ?? null;

    // Derive buyer/seller socket ids
    const buyerSocketId  = sideOfTaker === 'BUY' ? takerSocketId : makerSocketId;
    const sellerSocketId = sideOfTaker === 'BUY' ? makerSocketId : takerSocketId;

    // Derive: seller is maker iff taker buys
    const sellerIsMaker = sideOfTaker === 'BUY';

    // FUTURES detection (server-side convention)
    const isFutures =
      props && typeof props === 'object' &&
      (props.contract_id != null || props.contractId != null);

    // Enrich props idempotently
    let nextProps: any;
    if (props && typeof props === 'object') {
      nextProps = Object.prototype.hasOwnProperty.call(props, 'sellerIsMaker')
        ? props
        : { ...props, sellerIsMaker };
    } else {
      nextProps = { sellerIsMaker };
    }

    // Only for FUTURES, attach canonical prices (don’t overwrite if already present)
    if (isFutures) {
      const orderPriceNum = Number(nextProps?.price);
      const orderPrice = Number.isFinite(orderPriceNum) ? orderPriceNum : null;
      if (!Object.prototype.hasOwnProperty.call(nextProps, 'execPrice'))  nextProps.execPrice  = price;
      if (!Object.prototype.hasOwnProperty.call(nextProps, 'orderPrice')) nextProps.orderPrice = orderPrice;
    }
    
    return {
      price,
      quantity,
      makerSocketId,
      takerSocketId,
      makerUuid,
      takerUuid,
      sideOfTaker,
      props: nextProps,
      takerKeypair,
      makerKeypair,                 // <— normalized here
      buyerSocketId,
      sellerSocketId,
      type: isFutures ? EOrderType.FUTURES : EOrderType.SPOT as const,
    };
  });

  console.log('[EXEC/IN]', marketKey, normalized.length, normalized[0]);

  // Process each exec slice
  for (const ex of normalized) {
    try {
      const {
        price, quantity,
        makerSocketId, takerSocketId,
        makerUuid, takerUuid,
        sideOfTaker, props, takerKeypair, makerKeypair,
        buyerSocketId, sellerSocketId,
        type,
      } = ex;

      if (!buyerSocketId || !sellerSocketId) {
        console.warn('[EXEC] missing socket ids', { raw: ex, buyerSocketId, sellerSocketId });
        continue;
      }

      // Keys
      const buyerKey  = takerKeypair ?? { address: undefined, pubkey: undefined };
      const sellerKey = makerKeypair ?? { address: undefined, pubkey: undefined };

      let tradeProps: any;

      if (type === EOrderType.FUTURES) {
        // Ensure we carry contract id in a canonical field
        const cidRaw = props?.contract_id ?? props?.contractId;
        const contractId = Number(cidRaw);
        if (!Number.isFinite(contractId)) {
          console.warn('[EXEC] FUTURES missing/invalid contract_id', { marketKey, props });
          continue; // skip malformed
        }
        tradeProps = {
          ...props,
          // canonical futures fields expected by channel/wallet
          contract_id: contractId,
          amount: quantity,
          price: props?.execPrice ?? price, // exec (match) price drives PnL/fees
          // initMargin / collateral / transfer are preserved if present in props
        };
      } else {
        // SPOT shape: keep compatibility with existing wallet expectations
        const idDesired = props?.id_desired ?? props?.idDesired;
        const idForSale = props?.id_for_sale ?? props?.idForSale;
        tradeProps = {
          ...props,
          id_desired: idDesired,
          id_for_sale: idForSale,
          amountDesired: quantity,
          amountForSale: safeNumber(quantity * price),
          price,
        };
      }

      const tradeInfo: ITradeInfo = {
        type,
        buyer:  { socketId: buyerSocketId,  keypair: buyerKey,  uuid: takerUuid },
        seller: { socketId: sellerSocketId, keypair: sellerKey, uuid: makerUuid },
        taker: takerSocketId ?? '',
        maker: makerSocketId ?? '',
        props: tradeProps,
      };

      console.log('trade info '+JSON.stringify(tradeInfo))
      const res = await this.newChannel(tradeInfo, null);
      console.log('channel res '+JSON.stringify(res))
      if (res?.error) {
        console.error('[EXECS→Channel] error', res.error, { marketKey, exec: ex });
      }
    } catch (e) {
      console.error('[EXEC] handler threw', e);
    }
  }

  // === Per-socket refresh (once per batch) ===
  const sockets = new Set<string>(
    (normalized ?? [])
      .flatMap(ex => [ex.makerSocketId, ex.takerSocketId])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
  );

  let payload = '';
  try {
    payload = JSON.stringify({ event: EmitEvents.UPDATE_ORDERS_REQUEST, marketKey });
  } catch (e) {
    console.error('[EXEC] refresh: payload stringify failed', { marketKey, e });
    return;
  }

  for (const sid of sockets) {
    const ws = this._liveSessions.get(sid);
    if (!ws) {
      console.warn('[EXEC] refresh: missing live session', { sid, marketKey });
      continue;
    }

    // Best-effort OPEN check if the impl provides one
    const rstate = (ws as any)?.readyState;
    if (typeof rstate === 'number' && rstate !== 1 /* OPEN */) {
      console.warn('[EXEC] refresh: socket not OPEN', { sid, state: rstate, marketKey });
      continue;
    }

    try {
      ws.send(payload);
    } catch (e) {
      console.error('[EXEC] refresh send failed', { sid, marketKey, e });
    }
  }
}

  // === Market subscription helpers ===
  private subscribeMarket(socketId: string, marketKey: string, ws: WS) {
    if (!this._marketSubs.has(marketKey))
      this._marketSubs.set(marketKey, new Set());
    this._marketSubs.get(marketKey)!.add(socketId);

    if (!this._sessionSubs.has(socketId))
      this._sessionSubs.set(socketId, new Set());
    this._sessionSubs.get(socketId)!.add(marketKey);

    (ws as any)._markets.add(marketKey);
    console.log('[sub] add', socketId, marketKey, 'size=', this._sessionSubs.get(socketId)?.size);

    // one-shot snapshot
    this.sendOrderbookSnapshot(ws, marketKey);
  }

  private unsubscribeMarket(socketId: string, marketKey: string) {
    const ws = this._liveSessions.get(socketId);
    this._marketSubs.get(marketKey)?.delete(socketId);
    this._sessionSubs.get(socketId)?.delete(marketKey);
    (ws as any)?._markets?.delete(marketKey);
      console.log('[sub] del', socketId, marketKey, 'size=', this._sessionSubs.get(socketId)?.size);
  }

  // ensure socket↔market is indexed even if client never "joined"
private ensureSocketMarketIndex(socketId: string, marketKey: string) {
  if (!this._sessionSubs.has(socketId)) this._sessionSubs.set(socketId, new Set());
  this._sessionSubs.get(socketId)!.add(marketKey);

  if (!this._marketSubs.has(marketKey)) this._marketSubs.set(marketKey, new Set());
  this._marketSubs.get(marketKey)!.add(socketId);

  const ws = this._liveSessions.get(socketId) as any;
  if (ws?._markets instanceof Set) ws._markets.add(marketKey);
}


  public broadcastToMarket(marketKey: string, msg: object) {
    const ids = this._marketSubs.get(marketKey);
    if (!ids || ids.size === 0) return;
    const str = JSON.stringify(msg);
    for (const id of ids) {
      const ws = this._liveSessions.get(id);
      if (!ws) continue;
      try {
        if ((ws as any).bufferedAmount && (ws as any).bufferedAmount > 1_000_000){continue};
        ws.send(str);
      } catch {}
    }
  }

  public broadcastToAll(msg: object) {
    const str = JSON.stringify(msg);
    for (const ws of this._liveSessions.values()) {
      try {
        ws.send(str);
      } catch {}
    }
  }

    // === Snapshots/opened tray ===
  private sendOrderbookSnapshot(ws: WS, marketKey: string, depth = 50) {
    if (!marketKey) {
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        orders: [],
        isDelta: false,
        history: [],
      }));
      return;
    }

    try {
      const snapRaw = (native as any).snapshot?.(marketKey, depth);
      const snapObj = parseMaybeJson<any>(snapRaw, null);
      const orders = normalizeSnapshotToRows(snapObj, /* PRICE_SCALE */ 100);

      // Opened orders tray (support both arg orders just in case)
      const socketId = (ws as any).id as string;
      let opened: any[] = [];
      try {
        if (typeof (native as any).get_open_orders_by_socket === 'function') {
          // try (sid, market) first
          let openedRaw = (native as any).get_open_orders_by_socket(socketId, marketKey);
          if (!Array.isArray(openedRaw)) {
            // some builds are (market, sid)
            openedRaw = (native as any).get_open_orders_by_socket(marketKey, socketId);
          }
          opened = Array.isArray(openedRaw) ? openedRaw : [];
        }
      } catch {}

      const payload = {
        event: EmitEvents.ORDERBOOK_DATA,
        marketKey,
        orders,           // <-- always present, [] when empty
        isDelta: false,
        openedOrders: opened,
        history: [],
      };

      // send to caller
      ws.send(JSON.stringify(payload));
      // and to anyone joined on this market (so all views update)
      this.broadcastToMarket(marketKey, payload);

    } catch {
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        marketKey,
        orders: [],
        isDelta: false,
        history: [],
      }));
    }
  }

  // === WS lifecycle ===
  private handleClose(ws: WS) {
    const id = (ws as any).id as string;

    // Capture markets BEFORE mutating indices
    const joined = new Set(this._sessionSubs.get(id) ?? []);

    // Do the sweep first so listJoinedMarkets (or the captured set) has data
    this.sweepOrders(id, 'tcp-close', joined);

    // Now clean indices
    if (joined.size) {
      for (const mk of joined) this._marketSubs.get(mk)?.delete(id);
    }
    this._sessionSubs.delete(id);
    this._liveSessions.delete(id);

    console.log(`[SM] Connection closed: ${id}`);
  }

  private _seenClose(ws: WS, uuid: string, ms = 1500) {
    const sid = (ws as any).id as string;
    if (!uuid) return false; // don’t block if input is bad

    let byUuid = this._recentClose.get(sid);
    if (!byUuid) this._recentClose.set(sid, (byUuid = new Map<string, number>()));

    const now  = Date.now();
    const prev = byUuid.get(uuid);   // ← undefined on first sighting
    byUuid.set(uuid, now);
    console.log('dupe cancel? '+prev+' '+now+' '+prev+' '+Boolean(prev != null && (now - prev) < ms))
    // only treat as dup if we actually saw it before
    return prev != null && (now - prev) < ms;
  }

  /** Return all market keys this socket is currently subscribed to */
  public listJoinedMarkets(socketId: string): string[] {
    return Array.from(this._sessionSubs.get(socketId) ?? []);
  }

  private callPerMarket = (mk: string, id: string) => {
    const f = (native as any).cancel_all_by_socket;
    console.log('[typeof cancel_all_by_socket]', typeof f);
    if (typeof f !== 'function') {
      throw new Error('native.cancel_all_by_socket is missing on this object');
    }
    const r = f(mk, id);
    console.log('[sweep] cancel_all_by_socket(', mk, ',', id, ') ->', r);
    return r;
  };

 private sweepOrders(id: string, reason = 'tcp-close', markets?: Set<string> | string[]) {
    let list: string[] =
      (Array.isArray(markets) ? markets :
      markets instanceof Set ? Array.from(markets) :
      Array.from(this._sessionSubs.get(id) ?? []));

    if (list.length === 0) list = Array.from(this._marketSubs.keys());

    console.log('sweepOrders markets', list.length, list);

    try {
      for (const mk of list) {
        console.log('about to cancel all '+mk+' '+id)
        console.log('[native keys]', Object.keys(native));
        console.log(
          '[typeof cancel_all_by_socket_global]',
          typeof (native as any).cancel_all_by_socket_global
        );

        const res = this.callPerMarket(mk, id);
        console.log('res '+res)
      }
    } catch (e) {
      console.warn('[ws close purge err]', e);
    }

    // NEW: broadcast a fresh snapshot to all subs for each market
    for (const mk of list) {
      try {
        const snapRaw = (native as any).snapshot?.(mk, this._depth);
        const snapObj = parseMaybeJson<any>(snapRaw, null);
        const orders  = normalizeSnapshotToRows(snapObj, 100, 1e8);
        this.broadcastToMarket(mk, {
          event: EmitEvents.ORDERBOOK_DATA,
          marketKey: mk,
          orders,
          isDelta: false,
          history: [],
        });
      } catch (e) {
        console.warn('[sweep snapshot err]', mk, e);
      }
    }

    this._liveSessions.delete(id);
    console.log(`${id} disconnected (${reason})`);
  }


  // === Utilities ===
  private generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private deriveMarketFromOrder(data: any): string | null {
      const o = data?.order ?? data;
      console.log('data in deriver market '+JSON.stringify(data))
      // explicit beats inference
      const mk =
        o?.marketKey ??
        o?.symbol ??
        o?.props?.marketKey ??
        o?.props?.symbol;
      if (mk) return String(mk);

      // SPOT inference by IDs → "min-max"
      const f = o?.props?.id_for_sale ?? o?.id_for_sale;
      const d = o?.props?.id_desired  ?? o?.id_desired;
      const spot = this.spotKeyFromIds(f, d);
      if (spot) return spot;

      // FUTURES inference
      const cid = o?.props?.contract_id ?? o?.props?.contractId;
      const exp = o?.props?.expiry ?? o?.props?.maturity_block;
      const fut = this.futKey(cid, exp);
      if (fut) return fut;

      return null;
    }

    private resolveMarket(data: any): string | null {
      const mk =
        data?.marketKey ??
        data?.filter?.marketKey ??
        this.deriveMarketFromOrder(data);
      if (mk) return mk;
    }

  private normalizeOrder(raw: any, socketId: string): NormalizedOrder {
    const o: any = { ...(raw?.order ?? raw) };

    const uuid =
      o.uuid ||
      o.orderUUID ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const sideStr =
      (o.side || o.action || (o.props?.side as string) || 'BUY').toString();
    const side = sideStr.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    const price =
      Number(o.price ?? o.props?.price ?? o.rate ?? o.limit_price) || 0;
    const amount = Number(o.amount ?? o.props?.amount ?? o.quantity) || 0;

    if (!price || !amount) {
      return {
        uuid,
        socketId: socketId,
        price,
        amount,
        side: side as 'BUY' | 'SELL',
        error: 'Missing price/amount',
      };
    }

    return {
      uuid,
      socketId: socketId,
      price,
      amount,
      side: side as 'BUY' | 'SELL',
      type: o.type,
      action: o.action,
      props: o.props,
      keypair: o.keypair,
    };
  }

    private toJsOrder(o: {
      uuid: string;
      socketId: string;
      side?: string;
      type?: 'SPOT' | 'FUTURES';
      action?: 'BUY' | 'SELL';
      props?: any;
      price: number;
      amount: number;
      quantity?: number;
      keypair?: any;
    }): JsOrder {
      const side = (o.side || o.action || 'BUY').toUpperCase();
      const payload = {
        uuid: o.uuid,
        socketId: o.socketId,          // camelCase for your code
        socket_id: o.socketId,         // <-- snake_case for native/Rust
        side: side === 'SELL' ? 'SELL' : 'BUY',
        price: Number(o.price),
        amount: Number(o.amount ?? o.quantity ?? 0),
        props: o.props,
        keypair: o.keypair,
        type: o.type,
        action: o.action,
      } as any;

      return payload as JsOrder;
    }

      // === Debug helpers used by routes ===
      public get liveSessions(): string[] {
        return Array.from(this._liveSessions.keys());
      }
      public get sessionCount(): number {
        return this._liveSessions.size;
      }

      
    private async newChannel(tradeInfo: ITradeInfo, unfilled: TOrder | null): Promise<IResultChannelSwap> {
      try {
        const buyerSocketId  = tradeInfo.buyer.socketId;
        const sellerSocketId = tradeInfo.seller.socketId;

        const buyerSocket  = this._liveSessions.get(buyerSocketId);
        const sellerSocket = this._liveSessions.get(sellerSocketId);

        if (!buyerSocket || !sellerSocket) {
          console.error('[Channel] missing socket(s)', { buyerSocketId, sellerSocketId });
          return { error: 'One of the sockets is not available' };
        }

        const channel = new ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
        const channelRes = await channel.onReady();
        if (channelRes.error || !channelRes.data) return channelRes;

        const historyTrade: IHistoryTrade = {
          txid: channelRes.data.txid,
          time: Date.now(),
          ...tradeInfo,
        };
        this.saveToHistory?.(historyTrade); // no-op if not present
        return channelRes;
      } catch (error: any) {
        return { error: error?.message ?? String(error) };
      }
    }

      
	// Helper function for building trades
    private buildTrade(
      new_order: TOrder,
      old_order: TOrder
    ): IResult<{ unfilled: TOrder | null; tradeInfo: ITradeInfo }> {
      try {
        const ordersArray = [new_order, old_order];
        const buyOrder  = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);
        if (!buyOrder || !sellOrder) throw new Error('Building Trade Failed. Code 1');

        const newAmt = new_order.props.amount;
        const oldAmt = old_order.props.amount;
        const amount = Math.min(newAmt, oldAmt);
        const price  = old_order.props.price;
        const sellerIsMaker = old_order.action === EOrderAction.SELL;

        let tradeProps: any;
        let unfilled: TOrder | null = null;

        if (toEOrderType(buyOrder.type) === EOrderType.FUTURES) {
          // ---------- FUTURES branch ----------
          const pNew = new_order.props as IFuturesOrderProps;
          const pOld = old_order.props as IFuturesOrderProps;

          unfilled =
            newAmt > oldAmt
              ? ({ ...new_order, props: { ...pNew, amount: safeNumber(newAmt - oldAmt) } } as TOrder)
              : newAmt < oldAmt
              ? ({ ...old_order, props: { ...pOld, amount: safeNumber(oldAmt - newAmt) } } as TOrder)
              : null;

          tradeProps = {
            amount,
            contract_id: pNew.contract_id ?? pOld.contract_id,
            price,
            initMargin: pNew.initMargin ?? pOld.initMargin,
            collateral: pNew.collateral ?? pOld.collateral,
            sellerIsMaker,
          };
        } else {
          // ---------- SPOT branch ----------
          const pNew = new_order.props as ISpotOrderProps;
          const pOld = old_order.props as ISpotOrderProps;

          unfilled =
            newAmt > oldAmt
              ? ({ ...new_order, props: { ...pNew, amount: safeNumber(newAmt - oldAmt) } } as TOrder)
              : newAmt < oldAmt
              ? ({ ...old_order, props: { ...pOld, amount: safeNumber(oldAmt - newAmt) } } as TOrder)
              : null;

          tradeProps = {
            propIdDesired: pNew.id_desired ?? pOld.id_desired,
            propIdForSale: pNew.id_for_sale ?? pOld.id_for_sale,
            amountDesired: amount,
            amountForSale: safeNumber(amount * price),
            sellerIsMaker,
          };
        }

        const tradeInfo: ITradeInfo = {
          type: toEOrderType(new_order.type), // enum, not string
          buyer:  { socketId: buyOrder.socket_id,  keypair: buyOrder.keypair,  uuid: buyOrder.uuid },
          seller: { socketId: sellOrder.socket_id, keypair: sellOrder.keypair, uuid: sellOrder.uuid },
          taker: new_order.socket_id,
          maker: old_order.socket_id,
          props: tradeProps,
        };

        return { data: { unfilled, tradeInfo } };
      } catch (e: any) {
        return { error: e?.message ?? String(e) };
      }
    }

}

// singleton export
export const socketManager = new SocketManager();
