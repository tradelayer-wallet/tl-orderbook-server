import HyperExpress from 'hyper-express';
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";
import { EOrderAction } from "../../utils/types/orderbook.types";

export class SocketManager {
    private _liveSessions = new Map<string, HyperExpress.Websocket>();
    private _marketSubs = new Map<string, Set<string>>();   
    private _sessionSubs = new Map<string, Set<string>>();
    private _attached = new WeakSet<HyperExpress.Websocket>();
    private _recentClose = new Map<string, Map<string, number>>();

    constructor() {
        // NO servers here. Only manage global state.
    }

    
    private _seenClose(ws: HyperExpress.Websocket, uuid: string, ms = 1500) {
      const sid = (ws as any).id as string;
      let byUuid = this._recentClose.get(sid);
      if (!byUuid) this._recentClose.set(sid, byUuid = new Map());
      const now = Date.now();
      const last = byUuid.get(uuid) || 0;
      byUuid.set(uuid, now);
      return now - last < ms; // true → seen very recently
    }

    // Called from index.ts: server.ws('/ws', ws => socketManager.handleOpen(ws))
    handleOpen(ws: HyperExpress.Websocket) {
      const id = this.generateUniqueId();
      (ws as any).id = id;
      this._liveSessions.set(id, ws);

      // Per-socket state
      (ws as any)._markets = new Set<string>();
      (ws as any)._forwarders = (ws as any)._forwarders || {};

      // ---- attach bus → socket forwarders ONCE per socket ----
      if (!(ws as any)._forwarders.closeOrder) {
        // optional short-window de-dupe to avoid spam if upstream double-emits
        const recent = new Map<string, number>(); // uuid -> ts
        const seenRecently = (uuid: string, ms = 1200) => {
          const now = Date.now();
          const last = recent.get(uuid) || 0;
          recent.set(uuid, now);
          return now - last < ms;
        };

        const fwdClose = (evt: { orderUuid: string; marketKey?: string; [k: string]: any }) => {
          // market filter per socket
          const mk = evt.marketKey;
          const markets: Set<string> = (ws as any)._markets;
          if (mk && markets.size && !markets.has(mk)) return;

          if (evt.socketId && evt.socketId === (ws as any).id) return;
          // de-dupe per socket (belt & suspenders)
          if (seenRecently(evt.orderUuid)) return;

          try {
            ws.send(JSON.stringify({ event: 'close-order', ...evt }));
          } catch {/* ignore */}
        };

        (ws as any)._forwarders.closeOrder = fwdClose;


          console.log('[DBG] close-order listenerCount now:',
            orderbookManager.bus.listenerCount('close-order')
          );
        // IMPORTANT: bind to your single OB bus just once per socket
        orderbookManager.bus.on('close-order', fwdClose);
            console.log('[DBG] close-order listenerCount (post):',
            orderbookManager.bus.listenerCount('close-order')
          );
      }

      // ---- wire ws lifecycle ----
      ws.on('message', (m) => this.handleMessage(ws, m));
      ws.on('close',   ()  => this.handleClose(ws));

      // ---- initial snapshot (no live re-broadcast here) ----
      let ordersSnapshot = orderbookManager.orderbooks
      .map(ob => ob.orders)
      .reduce((acc, arr) => acc.concat(arr), [] as any[])
      .filter((o: any) => !o.lock);

      const historySnapshot = orderbookManager.getOrdersHistory();

      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        orders: ordersSnapshot || [],
        history: historySnapshot
      }));
      ws.send(JSON.stringify({ event: 'connected', id }));

      console.log(`[SM] OPEN ${id}, live=${this._liveSessions.size}`);
    }


    public getSocketById(id: string): HyperExpress.Websocket | undefined {
    return this._liveSessions.get(id);
    }

    // NEW: subscribe / unsubscribe helpers
    private subscribeMarket(socketId: string, marketKey: string, ws: HyperExpress.Websocket) {
      // track who’s subscribed (for admin/debug)
      if (!this._marketSubs.has(marketKey)) this._marketSubs.set(marketKey, new Set());
      this._marketSubs.get(marketKey)!.add(socketId);

      if (!this._sessionSubs.has(socketId)) this._sessionSubs.set(socketId, new Set());
      this._sessionSubs.get(socketId)!.add(marketKey);

      // per-socket market filter set (used by the single forwarder)
      const markets: Set<string> = (ws as any)._markets || ((ws as any)._markets = new Set());
      markets.add(marketKey);

      // send a one-shot snapshot for THIS market only
      const ob = orderbookManager.orderbooks.find(o => o.orderbookName === marketKey);
      if (ws && ob) {
        ws.send(JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          orders: ob.orders.filter(o => !o.lock),
          history: ob.historyTrades
        }));
      }
    }

    private unsubscribeMarket(socketId: string, marketKey: string) {
      const ws = this._liveSessions.get(socketId);
      if (!ws) return;

      this._marketSubs.get(marketKey)?.delete(socketId);
      this._sessionSubs.get(socketId)?.delete(marketKey);
      (ws as any)._markets?.delete(marketKey);
    }


    addSession(id: string, ws: HyperExpress.Websocket) {
    this._liveSessions.set(id, ws);
	  }

	  removeSession(id: string) {
	    this._liveSessions.delete(id);
	    for (const subs of this._marketSubs.values()) {
	      subs.delete(id);
	    }
	  }


    // NEW: targeted broadcast by market
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

    private handleClose(ws: HyperExpress.Websocket) {
      const id = (ws as any).id;
      this._liveSessions.delete(id);
      console.log(`[SM] Connection closed: ${id}`);

      // detach forwarders ONCE per socket
      const f = (ws as any)._forwarders;
      if (f?.closeOrder) {
        orderbookManager.bus.off('close-order', f.closeOrder);
        delete (ws as any)._forwarders.closeOrder;
      }

      // clear subscription indices
      const subs = this._sessionSubs.get(id);
      if (subs) {
        for (const mk of subs) this._marketSubs.get(mk)?.delete(id);
        this._sessionSubs.delete(id);
      }

      // purge user orders
      const openedOrders = orderbookManager.getOrdersBySocketId(id);
      openedOrders.forEach(o => {
        orderbookManager.removeOrder(o.uuid, id);
      });
    }


    private async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
        let data;
        //console.log('incoming message '+message)
        try {
            data = JSON.parse(
                typeof message === 'string' ? message : Buffer.from(message).toString()
            );
        } catch (e) {
            console.error('[SM] Failed to parse WS message', e, message);
            return;
        }

        switch (data.event) {
            case OnEvents.NEW_ORDER:
                await this.handleNewOrder(ws, data);
                break;
            case OnEvents.UPDATE_ORDERBOOK:
                this.handleUpdateOrderbook(ws, data);
                break;
            case OnEvents.CLOSE_ORDER:
                  const uuid = data.orderUUID;
                  console.log('inside close '+uuid)
                  if (this._seenClose(ws, uuid)) break;   // drop duplicate
                  console.log('handling it')
                  this.handleCloseOrder(ws, data);
                  break;
            case OnEvents.MANY_ORDERS:
                this.handleManyOrders(ws, data);
                break;
            case OnEvents.DISCONNECT:
                this.sweepOrders((ws as any).id, 'client-disconnect');
                ws.close();
                break;
            case OnEvents.ORDERBOOK_JOIN:
            if (data.marketKey) this.subscribeMarket((ws as any).id, String(data.marketKey),ws);
                    break;
            case OnEvents.ORDERBOOK_LEAVE:
            if (data.marketKey) this.unsubscribeMarket((ws as any).id, String(data.marketKey));
            break;
            default:
                break
                //console.log(`[SM] Unknown event type: ${data.event}`);
        }
    }

    private async handleNewOrder(ws: HyperExpress.Websocket, data: any) {
        if (!data.isLimitOrder) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Market Orders Not allowed' }));
            return;
        }

        if (data?.type === 'FUTURES' && data?.props) {
            if (data.props.contractId && !data.props.contract_id) {
                data.props.contract_id = data.props.contractId;
                delete data.props.contractId;
            }
        }
        
      if (data?.type === 'SPOT' && data?.props) {
            const f = data.props.id_for_sale;
            const d = data.props.id_desired;

            if (f == null || d == null) {
                ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Missing property IDs' }));
                return;
            }

            const baseId  = Math.min(f, d);
            const quoteId = Math.max(f, d);

            // BUY = selling base, desiring quote
            // SELL = selling quote, desiring base
            if (f === baseId && d === quoteId) {
                data.props.side = 'BUY';
            } else if (f === quoteId && d === baseId) {
                data.props.side = 'SELL';
            } else {
                // Defensive: malformed combo
                ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Invalid property ID pair' }));
                return;
            }

            // Normalize: enforce invariant for the book
            data.props.id_for_sale = f;
            data.props.id_desired  = d;
        }


        const id = (ws as any).id;
        const order = await orderFactory(data, id);
        const res = await orderbookManager.addOrder(order);

        if (res.error || !res.data) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: res.error || 'Undefined Error' }));
            return;
        }

        if (res.data.order) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED, orderUuid: res.data.order.uuid }));
            const openedOrders = orderbookManager.getOrdersBySocketId(id);
            const orderHistory = orderbookManager.getOrdersHistory();
            ws.send(JSON.stringify({ event: EmitEvents.PLACED_ORDERS, openedOrders, orderHistory }));
        }
    }

    handleUpdateOrderbook(ws, data) {
        const filter = data?.filter ?? data;   // accept {filter:{...}} or direct filter

        if (!filter) {
            const payload = {
                event: EmitEvents.ORDERBOOK_DATA,
                orders: [],
                history: []
            };
            return ws.send(JSON.stringify(payload));
        }

        const ob = orderbookManager.orderbooks.find(o => o.findByFilter(filter));

        const payload = {
            event: EmitEvents.ORDERBOOK_DATA,
            orders: ob ? ob.orders.filter(o => !o.lock) : [],
            history: ob ? ob.historyTrades : []
        };

        ws.send(JSON.stringify(payload));
    }

    private async handleManyOrders(ws: HyperExpress.Websocket, data: any) {
          const id = (ws as any).id;
          const rawOrders = data.orders as any[];

          await Promise.all(rawOrders.map(async raw => {
            const order = await orderFactory(raw, id);
            return orderbookManager.addOrder(order, true);
          }));

          ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED }));
        }


    private handleCloseOrder(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        const uuid = data.orderUUID;
        console.log('inside handle close '+id +' '+uuid)
        orderbookManager.removeOrder(uuid, id);
        const openedOrders = orderbookManager.getOrdersBySocketId(id);
        const orderHistory = orderbookManager.getOrdersHistory();
        ws.send(JSON.stringify({
            event: EmitEvents.PLACED_ORDERS,
            openedOrders,
            orderHistory
        }));
    }

    private sweepOrders(id: string, reason = 'tcp-close') {
        const opened = orderbookManager.getOrdersBySocketId(id);
        opened.forEach(o => orderbookManager.removeOrder(o.uuid, id));
        this._liveSessions.delete(id);
        console.log(`${id} disconnected (${reason}); purged ${opened.length} orders`);
    }

    private generateUniqueId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // For debugging:
    public get liveSessions() {
        return Array.from(this._liveSessions.keys());
    }

    public broadcastToAll(msg: object) {
        const str = JSON.stringify(msg);
        for (const ws of Array.from(this._liveSessions.values())) {
            try { ws.send(str); } catch (e) { }
        }
    }
}
