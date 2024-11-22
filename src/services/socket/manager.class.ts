import { FastifyInstance } from 'fastify';
import fastifyUwsPlugin from '@geut/fastify-uws/plugin';
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
    private _liveSessions: IClientSession[] = [];
    private app: fastify.FastifyInstance;  // Fastify app instance
    private server: any;

    constructor(private fastifyInstance: fastify.FastifyInstance) {
        this.initService();
    }

    private initService() {
        // Register fastify-uWS plugin
        this.fastifyInstance.register(fastifyUwsPlugin);

        // Once Fastify app is ready, we can access uWS app
        this.fastifyInstance.addHook('onReady', async () => {
            // Access the uWS app from Fastify
            const uwsApp = this.fastifyInstance.getUws();
            console.log("uWS App Initialized");

            // Handle WebSocket connections
            uwsApp.ws('/ws', {
                open: this.handleOpen.bind(this),
                message: this.handleMessage.bind(this),
                close: this.handleClose.bind(this),
            });
        });

        console.log('Socket Service Initialized with fastify-uWS');
    }

    // WebSocket connection open handler
    private handleOpen(ws: uWS.WebSocket) {
        // Track sessions when a new WebSocket connection is made
        this._liveSessions.push({
            id: ws.getId().toString(),
            startTime: Date.now(),
            ip: ws.getRemoteAddress(),
        });
        console.log(`New connection: ${ws.getId()}`);
    }

    // WebSocket connection close handler
    private handleClose(ws: uWS.WebSocket, code: number, message: ArrayBuffer) {
        // Remove sessions when a WebSocket connection is closed
        this._liveSessions = this._liveSessions.filter(session => session.id !== ws.getId().toString());
        console.log(`Connection closed: ${ws.getId()}`);
    }

    // Handle messages for various events
    private handleMessage(ws: uWS.WebSocket, message: ArrayBuffer) {
        const data = JSON.parse(Buffer.from(message).toString());

        // Handle different event types based on the 'event' key in the message
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
                this.handleDisconnect(ws, data);
                break;
            default:
                console.log(`Unknown event type: ${data.event}`);
                break;
        }
    }

    // Handle new order event
    private async handleNewOrder(ws: uWS.WebSocket, data: any) {
        if (!data.isLimitOrder) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Market Orders Not allowed' }));
            return;
        }

        // Adjust the mismatched parameters if needed
        if (data.type === 'SPOT') {
            const { id_for_sale, id_desired } = data.props;

            if (data.action === EOrderAction.SELL && id_for_sale >= id_desired) {
                data.action = EOrderAction.BUY;
            }

            if (data.action === EOrderAction.BUY && id_for_sale <= id_desired) {
                data.action = EOrderAction.SELL;
            }
        }

        // Create order and emit the response
        const order = await orderFactory(data, ws.getId().toString());
        const res = await orderbookManager.addOrder(order);
        if (res.error || !res.data) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: res.error || 'Undefined Error' }));
            return;
        }

        if (res.data.order) {
            ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED, orderUuid: res.data.order.uuid }));
            const openedOrders = orderbookManager.getOrdersBySocketId(ws.getId().toString());
            const orderHistory = orderbookManager.getOrdersHistory();
            ws.send(JSON.stringify({ event: EmitEvents.PLACED_ORDERS, openedOrders, orderHistory }));
        }
    }

    // Handle updating the orderbook event
    private async handleUpdateOrderbook(ws: uWS.WebSocket, data: any) {
        const filter = data.filter;
        const orderbook = orderbookManager.orderbooks.find(e => e.findByFilter(filter));
        const orders = orderbook ? orderbook.orders.filter(o => !o.lock) : [];
        const history = orderbook ? orderbook.historyTrades.filter(o => o.txid) : [];
        ws.send(JSON.stringify({ event: EmitEvents.ORDERBOOK_DATA, orders, history }));
    }

    // Handle closing an order
    private handleCloseOrder(ws: uWS.WebSocket, data: any) {
        const orderUUID = data.orderUUID;
        console.log('Canceling order on server: ' + orderUUID);
        const res = orderbookManager.removeOrder(orderUUID, ws.getId().toString());
        console.log('Cancel result: ' + JSON.stringify(res));
        const openedOrders = orderbookManager.getOrdersBySocketId(ws.getId().toString());
        const orderHistory = orderbookManager.getOrdersHistory();
        ws.send(JSON.stringify({ event: EmitEvents.PLACED_ORDERS, openedOrders, orderHistory }));
    }

    // Handle many orders
    private handleManyOrders(ws: uWS.WebSocket, data: any) {
        const rawOrders = data.orders;
        rawOrders.forEach(async (rawOrder: TRawOrder) => {
            const order: TOrder = orderFactory(rawOrder, ws.getId().toString());
            await orderbookManager.addOrder(order, true);
        });
        ws.send(JSON.stringify({ event: OrderEmitEvents.SAVED }));
    }

    // Handle disconnect event
    private handleDisconnect(ws: uWS.WebSocket, data: any) {
        const reason = data.reason;
        const openedOrders = orderbookManager.getOrdersBySocketId(ws.getId().toString());
        openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, ws.getId().toString()));
        console.log(`${ws.getId()} Disconnected! Reason: ${reason}`);
    }

    // Getter for live sessions
    public get liveSessions() {
        return this._liveSessions;
    }
}

// Export the SocketManager class
export { SocketManager };
