import HyperExpress from 'hyper-express';
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";
import { EOrderAction } from "../../utils/types/orderbook.types";

export class SocketManager {
    private _liveSessions = new Map<string, HyperExpress.Websocket>();

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
        const ordersSnapshot = orderbookManager.orderbooks
            .flatMap(ob => ob.orders)
            .filter(o => !o.lock);

        const historySnapshot = orderbookManager.getOrdersHistory();

        ws.send(JSON.stringify({
            event: EmitEvents.ORDERBOOK_DATA,
            orders: ordersSnapshot,
            history: historySnapshot
        }));
        ws.send(JSON.stringify({ event: 'connected', id }));
        console.log(`[SM] OPEN ${id}, live=${this._liveSessions.size}`);
    }

    private handleClose(ws: HyperExpress.Websocket) {
        const id = (ws as any).id;
        this._liveSessions.delete(id);
        console.log(`[SM] Connection closed: ${id}`);

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
            default:
                console.log(`[SM] Unknown event type: ${data.event}`);
        }
    }

    private async handleNewOrder(ws: HyperExpress.Websocket, data: any) {
        if (!data.isLimitOrder) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Market Orders Not allowed' }));
            return;
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

    private handleUpdateOrderbook(ws: HyperExpress.Websocket, data: any) {
        const filter = data.filter;
        const orderbook = orderbookManager.orderbooks.find(e => e.findByFilter(filter));
        const orders = orderbook ? orderbook.orders.filter(o => !o.lock) : [];
        const history = orderbook ? orderbook.historyTrades.filter(o => o.txid) : [];
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders, history }));
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
