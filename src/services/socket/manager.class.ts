import HyperExpress from 'hyper-express';
import { IResult } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";
import { EOrderAction } from "../../utils/types/orderbook.types";
import moment = require("moment");

interface IClientSession {
    id: string;
    startTime: number;
    ip: string;
}

export class SocketManager {
    private _liveSessions: Map<string, HyperExpress.Websocket> = new Map();

    constructor(private app: HyperExpress.Server) {
        console.log('SocketManager constructing');
        this.initService();
    }

    public getSocketById(socketId: string): HyperExpress.Websocket | undefined {
        return this._liveSessions.get(socketId);
    }

    private initService() {
        this.app.ws('/ws', (ws) => {
            this.handleOpen(ws);

            ws.on('message', (message) => {
                this.handleMessage(ws, message);
            });

            ws.on('close', () => {
                this.handleClose(ws);
            });
        });

        console.log('Socket Service Initialized with HyperExpress');
    }

    private handleOpen(ws: HyperExpress.Websocket) {
        const id = this.generateUniqueId();
        (ws as any).id = id;

        this._liveSessions.set(id, ws);
        console.log('[SM] OPEN', id, 'live=', this._liveSessions.size);

        ws.send(JSON.stringify({ event: 'connected', id }));
    }

    private handleClose(ws: HyperExpress.Websocket) {
        const id = (ws as any).id;
        this._liveSessions.delete(id);
        console.log(`Connection closed: ${id}`);

        const openedOrders = orderbookManager.getOrdersBySocketId(id);
        openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, id));
    }

    private async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
        const data = JSON.parse(
            typeof message === 'string' ? message : Buffer.from(message).toString()
        );

        switch (data.event) {
            case OnEvents.NEW_ORDER:
                this.handleNewOrder(ws, data);
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
                console.log(`Unknown event type: ${data.event}`);
                break;
        }
    }

    private async handleNewOrder(ws: HyperExpress.Websocket, data: any) {
        if (!data.isLimitOrder) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Market Orders Not allowed' }));
            return;
        }

        if (data.type === 'SPOT') {
            const { id_for_sale, id_desired } = data.props;

            if (data.action === EOrderAction.SELL && id_for_sale >= id_desired) {
                data.action = EOrderAction.BUY;
            }

            if (data.action === EOrderAction.BUY && id_for_sale <= id_desired) {
                data.action = EOrderAction.SELL;
            }
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

    private async handleUpdateOrderbook(ws: HyperExpress.Websocket, data: any) {
        console.log('updating ob with data ' + JSON.stringify(data));
        const filter = data.filter;
        const orderbook = orderbookManager.orderbooks.find(e => e.findByFilter(filter));
        const orders = orderbook ? orderbook.orders.filter(o => !o.lock) : [];
        const history = orderbook ? orderbook.historyTrades.filter(o => o.txid) : [];
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders, history }));
    }

    private handleManyOrders(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        const rawOrders = data.orders;
        rawOrders.forEach(async (rawOrder: TRawOrder) => {
            const order: TOrder = await orderFactory(rawOrder, id);
            await orderbookManager.addOrder(order, true);
        });
        ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED }));
    }

    private handleCloseOrder(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        const uuid = data.uuid;
        orderbookManager.removeOrder(uuid, id);
        ws.send(JSON.stringify({ event: OrderEmitEvents.CLOSE_ORDER, uuid }));
    }

    private handleDisconnect(ws: HyperExpress.Websocket, data: any) {
        const id = (ws as any).id;
        this._liveSessions.delete(id);
        const reason = data.reason;
        const openedOrders = orderbookManager.getOrdersBySocketId(id);
        openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, id));
        console.log(`${id} Disconnected! Reason: ${reason}`);
        ws.close();
    }

    private sweepOrders(id: string, reason = 'tcp-close') {
        const opened = orderbookManager.getOrdersBySocketId(id);
        opened.forEach(o => orderbookManager.removeOrder(o.uuid, id));
        console.log(`${id} disconnected (${reason}); purged ${opened.length} orders`);
        this._liveSessions.delete(id);
    }

    private generateUniqueId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    public get liveSessions() {
        console.log('Live sessions ', JSON.stringify(Array.from(this._liveSessions.keys())));
        return Array.from(this._liveSessions.keys());
    }

    public broadcastToAll(msg: object) {
        const str = JSON.stringify(msg);
        for (const ws of Array.from(this._liveSessions.values())) {
            try {
                ws.send(str);
            } catch (e) {
                console.warn('Failed to send to a ws:', e);
            }
        }
    }
}
