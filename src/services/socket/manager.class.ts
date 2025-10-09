// src/services/socket/manager.class.ts
import HyperExpress from 'hyper-express';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { native, registerNativeSinks, JsOrder, Exec } from '../../native';

type WS = HyperExpress.Websocket;

type NormalizedOrder = {
  uuid: string;
  socket_id: string;
  price: number;
  amount: number;
  side: 'BUY' | 'SELL';
  type?: 'SPOT' | 'FUTURES';
  action?: 'BUY' | 'SELL';
  props?: any;
  keypair?: any;
  error?: string;
};

export class SocketManager {
  private _liveSessions = new Map<string, WS>();
  private _marketSubs = new Map<string, Set<string>>();
  private _sessionSubs = new Map<string, Set<string>>();

  private _dirty = new Set<string>();                 // markets needing a push
  private _flushing = false;                          // gate the coalescer
  private _coalesceMs = 50;                           // tweak as needed
  private _depth = 40;                                // levels to send (lightweight)

  // local de-dupe for close-order spam per socket
  private _recentClose = new Map<string, Map<string, number>>();

  // local cache (optional): uuid -> { market, price?, quantity? }
  private _uuidToMarket = new Map<string, string>();
  private _byUuid = new Map<
    string,
    { market: string; price?: number; quantity?: number }
  >();

  private _tickHandle: NodeJS.Timeout | null = null;
  private _lastNativeSnap = new Map<string, any>(); // marketKey -> latest snapshot

  constructor() {
  // start periodic broadcaster
  this._tickHandle = setInterval(() => this.flushOrderbookData(), this._coalesceMs);

  // Wire native sinks → cache + exec handling
  registerNativeSinks({
        onSnapshot: (market: string, snapshot: any) => {
          // cache latest and mark dirty
          this._lastNativeSnap.set(market, snapshot);
          this._dirty.add(market);
        },
        onExecs: (market: string, execs: any[]) => {
          // fire and forget; don’t block the sink
          this._handleExecs?.(market, execs).catch((err: any) =>
            console.warn('[exec sink err]', err)
          );
        },
        onOrderEvent: (ev: any) => {
          if (ev.type === 'ADDED' && ev.uuid) {
            this._uuidToMarket.set(ev.uuid, ev.market);
          }
          if (ev.type === 'CANCELED' && ev.uuid) {
            this._uuidToMarket.delete(ev.uuid);
            this._byUuid.delete(ev.uuid);
          }
          if (ev.type === 'AMENDED' && ev.uuid) {
            const cur = this._byUuid.get(ev.uuid);
            if (cur) {
              if (typeof ev.quantity === 'number') cur.quantity = ev.quantity;
              if (typeof ev.price === 'number') cur.price = ev.price;
              this._byUuid.set(ev.uuid, cur);
            }
          }
        },
      });
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
      const mk    = this.resolveMarket(ws, data);
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
        const mk =
          String(data.marketKey ?? data?.filter?.marketKey ?? '') || '';
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

  private async handleNewOrder(ws: HyperExpress.Websocket, data: any) {
    // 🧱 1. Basic guards
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
    const market = this.resolveMarket(ws, data);
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

    try {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.SAVED,
        orderUuid: order.uuid
      }));

      // 🔧 4. Submit to native engine
      native.submit(market, this.toJsOrder(order));

      // 🧩 5. Immediate placed-orders tray
      console.log('about to call orders '+sid+' '+market)
      try {
        const openedRaw =
          (native as any).get_open_orders_by_socket?.(sid,market) ?? [];
          console.log('fetched orders '+JSON.stringify(openedRaw))
        const opened = Array.isArray(openedRaw) ? openedRaw : [];

        const history =
          (native as any).get_order_history_by_socket?.(market, sid) ??
          [];

        ws.send(JSON.stringify({
          event: EmitEvents.PLACED_ORDERS,
          openedOrders: opened,
          orderHistory: history
        }));
      } catch (err) {
        console.warn('[placed-orders err]', err);
      }

      // 📡 6. Broadcast snapshot to all subs
      try {
        const snap =
          this._lastNativeSnap.get(market) ?? native.snapshot(market, 50);
        if (snap) {
          this.broadcastToMarket(market, {
            event: EmitEvents.ORDERBOOK_DATA,
            marketKey: market,
            native: snap
          });
        }
      } catch (err) {
        console.warn('[snapshot broadcast err]', err);
      }
    } catch (e: any) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: e?.message || 'submit failed'
      }));
    }
  }

  private async handleManyOrders(ws: WS, data: any) {
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(ws, data);
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
    const market = this.resolveMarket(ws, data);
    if (!uuid) return;

    try {
      if (market) native.cancel(market, uuid);

      // return updated opened/history for this socket (if you want)
      ws.send(
        JSON.stringify({
          event: EmitEvents.PLACED_ORDERS,
          openedOrders: [], // optional: fill by calling native.get_open_orders_by_socket
          orderHistory: [], // optional: your history store or future native hook
        })
      );
    } finally {
      if (market)
        this.broadcastToMarket(market, {
          event: EmitEvents.UPDATE_ORDERS_REQUEST,
        });
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
      maker_socket_id?: string;
      taker_socket_id?: string;
      maker_ext_uuid?: string;
      taker_ext_uuid?: string;
    }>
  ) {
    
    // 2) per-socket refresh (so their trays update)
    const sockets = new Set<string>();
    for (const ex of execs) {
      if (ex.maker_socket_id) sockets.add(ex.maker_socket_id);
      if (ex.taker_socket_id) sockets.add(ex.taker_socket_id);
    }
    for (const sid of sockets) {
      const ws = this._liveSessions.get(sid);
      if (!ws) continue;
      ws.send(
        JSON.stringify({
          event: EmitEvents.UPDATE_ORDERS_REQUEST,
          marketKey,
        })
      );
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

    // one-shot snapshot
    this.sendOrderbookSnapshot(ws, marketKey);
  }

  private unsubscribeMarket(socketId: string, marketKey: string) {
    const ws = this._liveSessions.get(socketId);
    this._marketSubs.get(marketKey)?.delete(socketId);
    this._sessionSubs.get(socketId)?.delete(marketKey);
    (ws as any)?._markets?.delete(marketKey);
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
  private sendOrderbookSnapshot(ws: WS, marketKey: string) {
    if (!marketKey) {
      ws.send(
        JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          orders: [],
          history: [],
        })
      );
      return;
    }

    try {
      const snapRaw = native.snapshot(marketKey, 50); // tune depth as needed

      // optional: opened orders tray via native (if you added it)
      const socketId = (ws as any).id as string;
      let opened: any[] = [];
      try {
        if (
          typeof (native as any).get_open_orders_by_socket === 'function' &&
          marketKey
        ) {
          const openedRaw = (native as any).get_open_orders_by_socket(
            marketKey,
            socketId
          );
          opened = Array.isArray(openedRaw) ? openedRaw : [];
        }
      } catch {}

      ws.send(
        JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          native: snapRaw,
          marketKey,
          openedOrders: opened,
          history: [], // fill if/when you wire history
        })
      );
    } catch (e) {
      // fail safe (don’t kill socket)
      ws.send(
        JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          orders: [],
          history: [],
          marketKey,
        })
      );
    }
  }

  // === WS lifecycle ===
  private handleClose(ws: WS) {
    const id = (ws as any).id as string;

    // clear subscription indices
    const subs = this._sessionSubs.get(id);
    if (subs) {
      for (const mk of subs) this._marketSubs.get(mk)?.delete(id);
      this._sessionSubs.delete(id);
    }

    this._liveSessions.delete(id);
    console.log(`[SM] Connection closed: ${id}`);
    this.sweepOrders(id, 'tcp-close');
  }

  private _seenClose(ws: WS, uuid: string, ms = 1500) {
    const sid = (ws as any).id as string;
    let byUuid = this._recentClose.get(sid);
    if (!byUuid) this._recentClose.set(sid, (byUuid = new Map()));
    const now = Date.now();
    const last = byUuid.get(uuid) || 0;
    byUuid.set(uuid, now);
    return now - last < ms; // true → seen very recently
  }

  private sweepOrders(id: string, reason = 'tcp-close') {
    // If you wire a native cancel-by-socket, call it here.
    // native.cancel_all_by_socket(market, id) — per market if you add it.
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

    private resolveMarket(ws: HyperExpress.Websocket, data: any): string | null {
      const mk =
        data?.marketKey ??
        data?.filter?.marketKey ??
        this.deriveMarketFromOrder(data);
      if (mk) return mk;
      const joined: Set<string> | undefined = (ws as any)._markets;
      if (joined && joined.size === 1) return Array.from(joined)[0];
      return null;
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
        socket_id: socketId,
        price,
        amount,
        side: side as 'BUY' | 'SELL',
        error: 'Missing price/amount',
      };
    }

    return {
      uuid,
      socket_id: socketId,
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
        socket_id: string;
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
        return {
          uuid: o.uuid,
          socket_id: o.socket_id,
          side: side === 'SELL' ? 'SELL' : 'BUY',
          price: Number(o.price),
          amount: Number(o.amount ?? o.quantity ?? 0),
          // extra fields are carried in native.submit’s payload if your addon reads them
          // (the JsOrder type in native.ts already allows optional props)
          props: o.props,
          keypair: o.keypair,
          type: o.type,
          action: o.action,
        } as unknown as JsOrder;
      }

      // === Debug helpers used by routes ===
      public get liveSessions(): string[] {
        return Array.from(this._liveSessions.keys());
      }
      public get sessionCount(): number {
        return this._liveSessions.size;
      }
}

// singleton export
export const socketManager = new SocketManager();
