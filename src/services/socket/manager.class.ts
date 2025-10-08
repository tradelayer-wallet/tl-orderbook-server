// src/services/socket/manager.class.ts
import type HyperExpress from 'hyper-express';
import { native, registerNativeSinks } from '../../native';

export interface ISocketNotifier {
  broadcastToAll(payload: any): void;
  broadcastToMarket(market: string, payload: any): void;
  toSocket(id: string, payload: any): void;
}

type Json = Record<string, any>;

type Exec = {
  price: number;
  quantity: number;
  maker_socket_id?: string;
  taker_socket_id?: string;
  maker_ext_uuid?: string;
  taker_ext_uuid?: string;
};

enum OnEvents {
  NEW_ORDER = 'NEW_ORDER',
  UPDATE_ORDERBOOK = 'UPDATE_ORDERBOOK',
  CLOSE_ORDER = 'CLOSE_ORDER',
  MANY_ORDERS = 'MANY_ORDERS',
  DISCONNECT = 'DISCONNECT',
  ORDERBOOK_JOIN = 'ORDERBOOK_JOIN',
  ORDERBOOK_LEAVE = 'ORDERBOOK_LEAVE',
}

type RegistryOrder = {
  uuid: string;
  socket_id: string;
  type?: 'SPOT' | 'FUTURES';
  action?: 'BUY' | 'SELL';
  props?: any;
  price: number;
  quantity: number;
  keypair?: any;
};

export class SocketManager implements ISocketNotifier {
  private _liveSessions = new Map<string, HyperExpress.Websocket>();
  private _sessionSubs  = new Map<string, Set<string>>();   // socketId -> Set(market)
  private _seenClose    = new Map<string, Set<string>>();   // socketId -> Set(uuid)
  private _uuidToMarket = new Map<string, string>();
  private _byUuid       = new Map<string, RegistryOrder>();
  private _attached     = new WeakSet<HyperExpress.Websocket>();

  constructor() {
    // native sinks → fanout & exec handling
    registerNativeSinks({
      onSnapshot: (market, snapshot) =>
        this.broadcastToMarket(market, { event: 'orderbook-data', marketKey: market, native: snapshot }),
      onExecs: (market, execs) => this._handleExecs(market, execs),
      onOrderEvent: (ev) => {
        if (ev.type === 'ADDED' && ev.uuid) this._uuidToMarket.set(ev.uuid, ev.market);
        if (ev.type === 'CANCELED' && ev.uuid) {
          this._uuidToMarket.delete(ev.uuid);
          this._byUuid.delete(ev.uuid);
        }
        if (ev.type === 'AMENDED' && ev.uuid) {
          const cur = this._byUuid.get(ev.uuid);
          if (cur) {
            if (typeof ev.quantity === 'number') cur.quantity = ev.quantity;
            if (typeof ev.price === 'number')    cur.price    = ev.price;
            this._byUuid.set(ev.uuid, cur);
          }
        }
      }
    });
  }

  // === public API expected by your code ===
  handleOpen = (ws: HyperExpress.Websocket) => {
    if (this._attached.has(ws)) return;
    this._attached.add(ws);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    (ws as any).id = id;
    this._liveSessions.set(id, ws);
    this._sessionSubs.set(id, new Set());

    ws.on('message', (raw) => this.handleMessage(ws, raw));
    ws.once('close', () => {
      this._liveSessions.delete(id);
      this._sessionSubs.delete(id);
      this._seenClose.delete(id);
    });
  };

  get liveSessions() { return this._liveSessions; } // for logs.route.ts

  broadcastToAll(payload: Json) {
    const s = JSON.stringify(payload);
    for (const [, ws] of this._liveSessions) {
      try { ws.send(s); } catch {}
    }
  }

  broadcastToMarket(market: string, payload: Json) {
    const s = JSON.stringify(payload);
    for (const [sid, ws] of this._liveSessions) {
      const subs = this._sessionSubs.get(sid);
      if (!subs || !subs.has(market)) continue;
      try { ws.send(s); } catch {}
    }
  }

  toSocket(id: string, payload: Json) {
    const ws = this._liveSessions.get(id);
    if (!ws) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  getSocketById(id: string) { return this._liveSessions.get(id); }

  // === message router (keeps your event names) ===
  async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
    let data: any;
    try { data = JSON.parse(typeof message === 'string' ? message : Buffer.from(message).toString()); }
    catch (e) { console.error('[SM] bad msg', e); return; }

    switch (data.event) {
      case OnEvents.NEW_ORDER: {
        const market = String(data.marketKey || data.symbol || '');
        if (!market) break;
        const order = { ...(data.order || data), socket_id: (ws as any).id };
        if (order?.uuid) {
          this._byUuid.set(order.uuid, {
            uuid: order.uuid,
            socket_id: order.socket_id,
            type: order.type ?? 'SPOT',
            action: order.action ?? order.side ?? 'BUY',
            props: order.props ?? {},
            price: Number(order.price),
            quantity: Number(order.amount ?? order.quantity ?? 0),
            keypair: order.keypair,
          });
          this._uuidToMarket.set(order.uuid, market);
        }
        native.submit(market, order);
        break;
      }

      case OnEvents.CLOSE_ORDER: {
        const uuid = String(data.orderUUID || data.uuid || '');
        if (!uuid || this._seen(ws, uuid)) break;
        const market = String(data.marketKey || this._uuidToMarket.get(uuid) || '');
        if (market) native.cancel(market, uuid);
        break;
      }

      case OnEvents.MANY_ORDERS: {
        const market = String(data.marketKey || data.symbol || '');
        if (!market) break;
        const orders = (data.orders || []).map((o: any) => ({ ...o, socket_id: (ws as any).id }));
        for (const o of orders) {
          if (o?.uuid) {
            this._byUuid.set(o.uuid, {
              uuid: o.uuid,
              socket_id: o.socket_id,
              type: o.type ?? 'SPOT',
              action: o.action ?? o.side ?? 'BUY',
              props: o.props ?? {},
              price: Number(o.price),
              quantity: Number(o.amount ?? o.quantity ?? 0),
              keypair: o.keypair,
            });
            this._uuidToMarket.set(o.uuid, market);
          }
        }
        if ((native as any).submit_batch) (native as any).submit_batch({ market, place: orders, snap_levels: 50 });
        else for (const o of orders) native.submit(market, o);
        break;
      }

      case OnEvents.UPDATE_ORDERBOOK: {
        const market = String(data.marketKey || '');
        const uuid   = String(data.uuid || data.orderUUID || '');
        if (!market || !uuid) break;
        const newQty = (data.newAmount ?? data.newQty);
        const newPx  = data.newPrice;
        if (typeof native.edit === 'function') native.edit(market, uuid, newQty, newPx);
        break;
      }

      case OnEvents.DISCONNECT: {
        ws.close();
        break;
      }

      case OnEvents.ORDERBOOK_JOIN: {
        const mk = String(data.marketKey ?? ''); if (!mk) break;
        const subs = this._sessionSubs.get((ws as any).id);
        if (subs && !subs.has(mk)) subs.add(mk);
        break;
      }

      case OnEvents.ORDERBOOK_LEAVE: {
        const mk = String(data.marketKey ?? ''); if (!mk) break;
        this._sessionSubs.get((ws as any).id)?.delete(mk);
        break;
      }

      default:
        console.log(`[SM] Unknown event type: ${data.event}`);
    }
  }

  // === exec handling (simplified: forward to both sides; keep your ChannelSwap elsewhere) ===
  private async _handleExecs(market: string, execs: Exec[]) {
    for (const e of execs) {
      if (e.taker_socket_id) this.toSocket(e.taker_socket_id, { event: 'execution', marketKey: market, exec: e });
      if (e.maker_socket_id) this.toSocket(e.maker_socket_id, { event: 'execution', marketKey: market, exec: e });
    }
  }

  private _seen(ws: HyperExpress.Websocket, uuid: string): boolean {
    const id = (ws as any).id as string;
    let s = this._seenClose.get(id);
    if (!s) { s = new Set(); this._seenClose.set(id, s); }
    if (s.has(uuid)) return true;
    s.add(uuid);
    setTimeout(() => s!.delete(uuid), 3000);
    return false;
  }
}
