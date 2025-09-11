import HyperExpress from 'hyper-express';
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";
import { EOrderAction } from "../../utils/types/orderbook.types";

export class SocketManager {
    private _liveSessions = new Map<string, HyperExpress.Websocket>();
    private _marketSubs = new Map<string, Set<string>>();   
    private _sessionSubs = new Map<string, Set<string>>();

    constructor() {
        // NO servers here. Only manage global state.
    }

    // Called from index.ts: server.ws('/ws', ws => socketManager.handleOpen(ws))
    handleOpen(ws: HyperExpress.Websocket) {
        const id = this.generateUniqueId();
        (ws as any).id = id;
        this._liveSessions.set(id, ws);

        ws.on('message', (m) => this.handleMessage(ws, m));
        ws.on('close',   ()  => this.handleClose(ws));

        // Initial orderbook snapshot, history, etc.
        let ordersSnapshot = orderbookManager.orderbooks
            .map(ob => ob.orders)
            .reduce((a, b) => a.concat(b), [])
            .filter(o => !o.lock);

        console.log('ordersSnapshot on open '+JSON.stringify(ordersSnapshot))
        if(!ordersSnapshot){ordersSnapshot=[]}

        const historySnapshot = orderbookManager.getOrdersHistory();

        ws.send(JSON.stringify({
            event: EmitEvents.ORDERBOOK_DATA,
            orders: ordersSnapshot,
            history: historySnapshot
        }));
        ws.send(JSON.stringify({ event: 'connected', id }));
        console.log(`[SM] OPEN ${id}, live=${this._liveSessions.size}`);
    }

    public getSocketById(id: string): HyperExpress.Websocket | undefined {
    return this._liveSessions.get(id);
    }

    // NEW: subscribe / unsubscribe helpers
    private subscribeMarket(socketId: string, marketKey: string, socket: HyperExpress.Websocket){
        if (!this._marketSubs.has(marketKey)) this._marketSubs.set(marketKey, new Set());
        this._marketSubs.get(marketKey)!.add(socketId);
        if (!this._sessionSubs.has(socketId)) this._sessionSubs.set(socketId, new Set());
        this._sessionSubs.get(socketId)!.add(marketKey);
		  const ob = orderbookManager.orderbooks.find(o => o.orderbookName === marketKey);

		  if (socket && ob) {
		    socket.emit(EmitEvents.ORDERBOOK_DATA as any, {
			  orders: ob.orders.filter(o => !o.lock),
			  history: ob.historyTrades,
			});
		  }
    }

    private unsubscribeMarket(socketId: string, marketKey: string) {
        this._marketSubs.get(marketKey)?.delete(socketId);
        this._sessionSubs.get(socketId)?.delete(marketKey);
    }

    addSession(id: string, ws: HyperExpress.Websocket) {
    this._liveSessions.set(id, ws);

	    // listen for JOIN/LEAVE events from client
	    ws.on('message', (raw: string) => {
	      try {
	        const msg = JSON.parse(raw);
	        if (msg.event === 'ORDERBOOK_JOIN') {
	          this.subscribeMarket(id, msg.marketKey,ws);
	        } else if (msg.event === 'ORDERBOOK_LEAVE') {
	          this.unsubscribeMarket(id, msg.marketKey);
	        }
	      } catch (err) {
	        console.error('bad ws msg', err);
	      }
	    });
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

        const subs = this._sessionSubs.get(id);
        if (subs) {
            for (const mk of subs) this._marketSubs.get(mk)?.delete(id);
            this._sessionSubs.delete(id);
        }

        // Purge user orders
        const openedOrders = orderbookManager.getOrdersBySocketId(id);
        openedOrders.forEach(o => {
            orderbookManager.removeOrder(o.uuid, id);
        });
    }

    private async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
        let data;
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
                console.log(`[SM] Unknown event type: ${data.event}`);
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
        // (Add your spot/futures logic here, as in your version...)

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

    handleUpdateOrderbook(socket, data) {
        const filter = data?.filter ?? data;   // accept {filter:{...}} or direct filter

        console.log('filter in update orderbook '+JSON.stringify(filter))
        if (!filter) {
          return socket.emit(EmitEvents.ORDERBOOK_DATA, { orders: [], history: [] });
        }
		const ob = orderbookManager.orderbooks.find(o => o.findByFilter(filter));
        console.log('ob result by filter '+JSON.stringify(ob))
        console.log('[SM] handleUpdateOrderbook ws.id', (ws as any).id);

        if (!ob) {
          return socket.emit(EmitEvents.ORDERBOOK_DATA, { orders: [], history: [] });
        }

        socket.emit(EmitEvents.ORDERBOOK_DATA, {
          orders: ob.orders.filter(o => !o.lock),
          history: ob.historyTrades,
        });
    }

    private handleManyOrders(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        const rawOrders = data.orders;
        rawOrders.forEach(async (rawOrder: any) => {
            const order = await orderFactory(rawOrder, id);
            await orderbookManager.addOrder(order, true);
        });
        ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED }));
    }

    private handleCloseOrder(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        const uuid = data.orderUUID;
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
