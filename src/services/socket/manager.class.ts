// src/services/socket/manager.class.ts
import HyperExpress from 'hyper-express';
import { native } from '../../native';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { ChannelSwap } from '../../services/channel/ChannelSwap';

type Json = Record<string, any>;

type NormalizedOrder =
  | {
      uuid: string;
      socket_id: string;
      side?: string;
      type?: 'SPOT' | 'FUTURES';
      action?: 'BUY' | 'SELL';
      props?: any;
      price: number;
      amount: number;
      quantity?: number; // tolerated inbound
      keypair?: any;
    }
  | { error: string };

export class SocketManager {
  private _liveSessions = new Map<string, HyperExpress.Websocket>();
  private _marketSubs = new Map<string, Set<string>>();   // marketKey -> socketIds
  private _sessionSubs = new Map<string, Set<string>>();  // socketId  -> marketKeys
  private _attached = new WeakSet<HyperExpress.Websocket>();
  private _recentClose = new Map<string, Map<string, number>>(); // socket -> (uuid -> ts)

  constructor() {
    // no servers here
  }

  // ---------------- lifecycle ----------------
  handleOpen(ws: HyperExpress.Websocket) {
    if (this._attached.has(ws)) return;
    this._attached.add(ws);

    const id = this.generateUniqueId();
    (ws as any).id = id;
    this._liveSessions.set(id, ws);

    (ws as any)._markets = new Set<string>();

    // client expects this exact event on connect
    try {
      ws.send(JSON.stringify({ event: 'connected', id }));
    } catch {}

    ws.on('message', (m) => this.handleMessage(ws, m));
    ws.on('close',   ()  => this.handleClose(ws));

    // Initial snapshot (empty/global for Rust path; clients will JOIN for market snapshots)
    try {
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        orders: [],
        history: []
      }));
    } catch {}

    console.log(`[SM] OPEN ${id}, live=${this._liveSessions.size}`);
  }

  private handleClose(ws: HyperExpress.Websocket) {
    const id = (ws as any).id;
    this._liveSessions.delete(id);
    console.log(`[SM] Connection closed: ${id}`);

    // unsubscribe from all markets
    const subs = this._sessionSubs.get(id);
    if (subs) {
      for (const mk of subs) this._marketSubs.get(mk)?.delete(id);
      this._sessionSubs.delete(id);
    }

    // If you expose native.cancel_all_by_socket, you can loop subs and call it here.
  }

  registerNativeSinks({
    onSnapshot: (market, snapshot) => {
        this.broadcastToMarket(market, { event: 'orderbook-data', marketKey: market, native: snapshot });
      },
      onExecs: (market, execs) => {
        // fanout + channel creation
        this._handleExecs(market, execs).catch(err => console.warn('[exec sink err]', err));
      },
      onOrderEvent: (ev) => {
        if (ev.type === 'ADDED' && ev.uuid) this._uuidToMarket.set(ev.uuid, ev.market);
        else if (ev.type === 'CANCELED' && ev.uuid) {
          this._uuidToMarket.delete(ev.uuid);
          this._byUuid.delete(ev.uuid);
        } else if (ev.type === 'AMENDED' && ev.uuid) {
          const cur = this._byUuid.get(ev.uuid);
          if (cur) {
            if (typeof ev.quantity === 'number') cur.quantity = ev.quantity;
            if (typeof ev.price    === 'number') cur.price    = ev.price;
            this._byUuid.set(ev.uuid, cur);
          }
        }
      }
    });

    /**
     * Handle executions coming from native (rust). For each slice we:
     *  - emit to taker + maker sockets
     *  - build a TradeInfo-like object
     *  - run ChannelSwap and persist to history
     */
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
      for (const ex of execs) {
        const makerSocket = ex.maker_socket_id ? this._liveSessions.get(ex.maker_socket_id) : undefined;
        const takerSocket = ex.taker_socket_id ? this._liveSessions.get(ex.taker_socket_id) : undefined;

        // 1) WS fanout to both sides (non-fatal if either is gone)
        const payload = {
          event: EmitEvents.MATCHED,
          marketKey,
          price: ex.price,
          quantity: ex.quantity,
          makerUuid: ex.maker_ext_uuid,
          takerUuid: ex.taker_ext_uuid
        };
        if (makerSocket) { try { makerSocket.send(JSON.stringify(payload)); } catch {} }
        if (takerSocket) { try { takerSocket.send(JSON.stringify(payload)); } catch {} }

        // 2) Build minimal "tradeInfo" compatible with your old ChannelSwap path
        //    We only include what ChannelSwap actually uses (sockets + props).
        if (makerSocket && takerSocket) {
          const tradeInfo: any = {
            type: 'SPOT',              // or infer from marketKey if you keep futures here
            buyer:  { socketId: ex.taker_socket_id },
            seller: { socketId: ex.maker_socket_id },
            taker:  ex.taker_socket_id,
            maker:  ex.maker_socket_id,
            props: {
              // fill what the channel needs – keep it numeric/simple
              amountDesired: ex.quantity,
              amountForSale: ex.quantity * ex.price,
              price: ex.price,
              sellerIsMaker: true,
              transfer: false
            }
          };

          // 3) Start the channel (legacy behavior) and persist history
          try {
            const channel = new ChannelSwap(takerSocket, makerSocket, tradeInfo, /*unfilled*/ null);
            const res = await channel.onReady(); // returns { data?: { txid }, error?: string }
            if (!res?.error && res?.data?.txid) {
              const historyTrade = {
                txid: res.data.txid,
                time: Date.now(),
                ...tradeInfo
              };
              saveToHistory(historyTrade);
            }
          } catch (err) {
            console.warn('[channel error]', err);
          }
        }
      }
    }


    private getSocketById(id?: string) {
      return id ? this._liveSessions.get(id) : undefined;
    }


  // --------------- routing -------------------
  private async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
    let data: any;
    try {
      data = JSON.parse(typeof message === 'string' ? message : Buffer.from(message).toString());
    } catch (e) {
      console.error('[SM] Failed to parse WS message', e, message);
      return;
    }

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
        if (!uuid) break;
        if (this._seenClose(ws, uuid)) break;   // drop duplicate spam
        this.handleCloseOrder(ws, data);
        break;
      }
      case OnEvents.MANY_ORDERS: {
        await this.handleManyOrders(ws, data);
        break;
      }
      case OnEvents.UPDATE_ORDERBOOK: {
          // accept either {marketKey} or the old {filter:{marketKey}}
          const mk =
            String(data.marketKey ?? data?.filter?.marketKey ?? '') || '';
          this.sendOrderbookSnapshot(ws, mk);
          break;
        }
      case OnEvents.DISCONNECT: {
        this.sweepOrders((ws as any).id, 'client-disconnect');
        ws.close();
        break;
      }
      case OnEvents.ORDERBOOK_JOIN: {
        if (data.marketKey) this.subscribeMarket((ws as any).id, String(data.marketKey), ws);
        break;
      }
      case OnEvents.ORDERBOOK_LEAVE: {
        if (data.marketKey) this.unsubscribeMarket((ws as any).id, String(data.marketKey));
        break;
      }
      default:
        console.log(`[SM] Unknown event type: ${data.event}`);
    }
  }

  // --------------- single order ---------------
  private async handleNewOrder(ws: HyperExpress.Websocket, data: any) {
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(ws, data);    
    if (!market) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Missing marketKey' }));
      return;
    }

    const order = this.normalizeOrder(data, sid) as NormalizedOrder;

    if ('error' in order) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: order.error }));
      return;
    }

    // Fast confirmation your client expects
    try {
      ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED, orderUuid: order.uuid }));
    } catch {}

    // Submit to engine
    try {
        native.submit(market, this.toJsOrder(order));
      // and prompt UIs to update
      this.broadcastToMarket(market, { event: EmitEvents.UPDATE_ORDERS_REQUEST });
    } catch (e: any) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: e?.message || 'submit failed' }));
    }
  }

  // --------------- batch orders ----------------
  private async handleManyOrders(ws: HyperExpress.Websocket, data: any) {
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(ws, data);    
    if (!market) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Missing marketKey' }));
      return;
    }

    const rawOrders: any[] = Array.isArray(data.orders) ? data.orders : [];
    const normalized = rawOrders.map(o => this.normalizeOrder(o, sid) as NormalizedOrder);

    const orders = normalized.filter((o): o is Exclude<NormalizedOrder, {error: string}> => !('error' in o));

    // Client expects placed-orders with openedOrders+orderHistory arrays;
    // We don’t track them TS-side now, so return empty arrays (compatible).
    try {
      ws.send(JSON.stringify({
        event: EmitEvents.PLACED_ORDERS,
        openedOrders: [],
        orderHistory: []
      }));
    } catch {}

    try {
     const jsOrders = orders.map(o => this.toJsOrder(o));
        if ((native as any).submit_batch) {
          (native as any).submit_batch({ market, place: jsOrders, snap_levels: 50 });
        } else {
          for (const o of jsOrders) native.submit(market, o);
        }

      this.broadcastToMarket(market, { event: EmitEvents.UPDATE_ORDERS_REQUEST });
    } catch (e: any) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: e?.message || 'batch submit failed' }));
    }
  }

  // --------------- cancel ----------------
  private handleCloseOrder(ws: HyperExpress.Websocket, data: any) {
    const uuid = String(data.orderUUID || data.uuid || '');
    const market = this.resolveMarket(ws, data);    if (!uuid) return;
    try {
      if (market) native.cancel(market, uuid);
    } catch {}

    // legacy client refresh payload shape
    try {
      ws.send(JSON.stringify({
        event: EmitEvents.PLACED_ORDERS,
        openedOrders: [],
        orderHistory: []
      }));
    } catch {}

    if (market) this.broadcastToMarket(market, { event: EmitEvents.UPDATE_ORDERS_REQUEST });
  }

  // --------------- snapshots ----------------
  private handleUpdateOrderbook(ws: HyperExpress.Websocket, data: any) {
    const mk = String(data.marketKey || data.symbol || '');
    if (!mk || typeof native.snapshot !== 'function') {
      try {
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders: [], history: [] }));
      } catch {}
      return;
    }

    try {
      const snap = native.snapshot(mk, 50); // depth
      ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, native: snap, marketKey: mk }));
    } catch {
      try {
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders: [], history: [] }));
      } catch {}
    }
  }

  private subscribeMarket(socketId: string, marketKey: string, ws: HyperExpress.Websocket) {
    if (!this._marketSubs.has(marketKey)) this._marketSubs.set(marketKey, new Set());
    this._marketSubs.get(marketKey)!.add(socketId);

    if (!this._sessionSubs.has(socketId)) this._sessionSubs.set(socketId, new Set());
    this._sessionSubs.get(socketId)!.add(marketKey);

    (ws as any)._markets.add(marketKey);

    // send a one-shot snapshot for THIS market only (native)
    if (typeof native.snapshot === 'function') {
      try {
        const snap = native.snapshot(marketKey, 50);
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, native: snap, marketKey }));
      } catch {}
    } else {
      try {
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders: [], history: [], marketKey }));
      } catch {}
    }
  }

  private unsubscribeMarket(socketId: string, marketKey: string) {
    const ws = this._liveSessions.get(socketId);
    if (!ws) return;

    this._marketSubs.get(marketKey)?.delete(socketId);
    this._sessionSubs.get(socketId)?.delete(marketKey);
    (ws as any)._markets?.delete(marketKey);
  }

  // --------------- utilities ----------------
  public broadcastToMarket(marketKey: string, msg: object) {
    const ids = this._marketSubs.get(marketKey);
    if (!ids || ids.size === 0) return;
    const str = JSON.stringify(msg);
    for (const id of ids) {
      const ws = this._liveSessions.get(id);
      if (!ws) continue;
      try { ws.send(str); } catch {}
    }
  }

  public broadcastToAll(msg: object) {
    const str = JSON.stringify(msg);
    for (const ws of this._liveSessions.values()) {
      try { ws.send(str); } catch {}
    }
  }

  // Return a Map so routes can use .size
  public get liveSessions() {
    return this._liveSessions;
  }

  private _seenClose(ws: HyperExpress.Websocket, uuid: string, ms = 1500) {
    const sid = (ws as any).id as string;
    let byUuid = this._recentClose.get(sid);
    if (!byUuid) this._recentClose.set(sid, (byUuid = new Map()));
    const now = Date.now();
    const last = byUuid.get(uuid) || 0;
    byUuid.set(uuid, now);
    return now - last < ms;
  }

  private sweepOrders(id: string, reason = 'tcp-close') {
    // With Rust engine we don’t track per-socket orders in TS.
    this._liveSessions.delete(id);
    console.log(`${id} disconnected (${reason})`);
  }
// Derive a stable market key from the order itself (no mapping needed)
private deriveMarketFromOrder(data: any): string | null {
  const o = data?.order ?? data;
  // SPOT: ids determine the book; use a stable textual key
  if (o?.type === 'SPOT' && o?.props) {
    const f = Number(o.props.id_for_sale);
    const d = Number(o.props.id_desired);
    if (Number.isFinite(f) && Number.isFinite(d)) {
      const base  = Math.min(f, d);
      const quote = Math.max(f, d);
      return `spot-${base}-${quote}`;
    }
  }
  // FUTURES: use contract_id as-is
  if (o?.type === 'FUTURES' && o?.props?.contract_id) {
    return `fut-${String(o.props.contract_id)}`;
  }
  return null;
}

// Accept common aliases; fallback to the one joined market; else derive from order
private resolveMarket(ws: HyperExpress.Websocket, data: any): string | null {
  const aliases = ['marketKey','market','symbol','orderbook','orderbookName','pair'];
  for (const k of aliases) {
    const v = data?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const joined: Set<string> | undefined = (ws as any)._markets;
  if (joined && joined.size === 1) return [...joined][0];
  return this.deriveMarketFromOrder(data);
}


  private generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // -------- normalize order for Rust --------
  private normalizeOrder(raw: any, socketId: string): NormalizedOrder {
    const o: any = { ...(raw?.order ?? raw) };

    // SPOT side derivation like your legacy code
    if (o?.type === 'SPOT' && o?.props) {
      const f = o.props.id_for_sale;
      const d = o.props.id_desired;
      if (f == null || d == null) return { error: 'Missing property IDs' };
      const baseId = Math.min(f, d);
      const quoteId = Math.max(f, d);
      if (f === baseId && d === quoteId) o.props.side = 'BUY';
      else if (f === quoteId && d === baseId) o.props.side = 'SELL';
      else return { error: 'Invalid property ID pair' };
    }

    // prefer explicit `side`, else from action/props.side
    if (!o.side) o.side = o.action || o?.props?.side;
    if (o.side) o.side = String(o.side).toUpperCase();

    // lift price/amount from props if nested
    if (o.props) {
      if (o.price == null && o.props.price != null)  o.price = o.props.price;
      if (o.amount == null && o.props.amount != null) o.amount = o.props.amount;
    }
    if (o.amount == null && o.quantity != null) o.amount = o.quantity;

    // ensure numeric
    if (o.price == null || isNaN(Number(o.price))) return { error: 'Missing/invalid price' };
    if (o.amount == null || isNaN(Number(o.amount))) return { error: 'Missing/invalid amount' };

    o.price  = Number(o.price);
    o.amount = Number(o.amount);

    // uuid & socket
    if (!o.uuid) o.uuid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    o.socket_id = socketId;

    return o as NormalizedOrder;
  }

  // Coerce to the union type the native binding expects
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
    }) {
      const side = (o.side || o.action || 'BUY').toUpperCase();
      const literalSide = side === 'SELL' ? 'SELL' : 'BUY' as 'BUY' | 'SELL';

      // Keep any extra fields your Rust bridge tolerates
      return {
        ...o,
        side: literalSide,
      };
    }

    private sendOrderbookSnapshot(ws: HyperExpress.Websocket, marketKey: string) {
      try {
        if (!marketKey) {
          ws.send(
            JSON.stringify({
              event: EmitEvents.ORDERBOOK_DATA,
              orders: [],
              history: [],
              orderbook: null
            })
          );
          return;
        }

        // 1) Orderbook snapshot (native → JSON string)
        const snapRaw = native.snapshot(marketKey, 50); // 50 levels; tune as needed
        const snapshot = typeof snapRaw === 'string' ? JSON.parse(snapRaw || 'null') : snapRaw;

        // 2) Opened orders tray for this socket & market (native helper)
        const socketId = (ws as any).id as string;
        let openedOrders: string[] = [];
        if (typeof native.get_open_orders_by_socket === 'function') {
          const openedRaw = native.get_open_orders_by_socket(marketKey, socketId);
          openedOrders = JSON.parse(openedRaw || '[]');
        }

        // 3) History (keep legacy field for UI; fill later when you hook native)
        const orderHistory: any[] = []; // or keep your old manager-based history if you still have it

        // 4) Emit in the exact shape your FE expects
        ws.send(
          JSON.stringify({
            event: EmitEvents.ORDERBOOK_DATA,
            // keep legacy fields so existing UI renders:
            orders: [],                // (legacy flat orders; we don’t build these now)
            history: orderHistory,     // (legacy)
            // new rich snapshot for book view:
            orderbook: snapshot,
            // opened tray (UUIDs):
            openedOrders
          })
        );
      } catch (err) {
        console.error('[SM] sendOrderbookSnapshot error', err);
        try {
          ws.send(
            JSON.stringify({
              event: EmitEvents.ORDERBOOK_DATA,
              orders: [],
              history: [],
              orderbook: null
            })
          );
        } catch {}
      }
    }

}
