import * as fs from 'fs';
import { FastifyInstance } from "fastify";
import { Server, Socket } from "socket.io";
import { socketIoAllowRequest, socketIoCorsOptions } from "../../config/cors";
import { TFilter } from "../../utils/types/markets.types";
import { TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { routeSwapEvent } from "../channel-swap/channel-swap.class";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";
import { orderRateLimiter, queryRateLimiter, releaseSocketLimiters } from "./limiters";

// DoS bounds: max orders per many-orders batch and max socket.io message size.
// The order burst (see limiters.ts) covers a full many-orders batch, so a
// legitimate ladder is never half-dropped by the limiter.
const MAX_BATCH_ORDERS = 100;
const MAX_HTTP_BUFFER_SIZE = 1e6;

interface IClientSession {
    id: string;
    startTime: number;
    ip: string;
};

export class SocketManager {
    private _liveSessions: IClientSession[] = [];
    constructor(
        private server: FastifyInstance,
    ) {
        this.initService();
    }

    get io(): Server {
        return this.server['io'];
    }

    get liveSessions() {
        return this._liveSessions;
    }

    private initService() {
         const httpsOptions = {
            key: fs.readFileSync('/etc/letsencrypt/live/ws.layerwallet.com/privkey.pem'),
            cert: fs.readFileSync('/etc/letsencrypt/live/ws.layerwallet.com/fullchain.pem'),
        };
        const fastifyIO = require("fastify-socket.io");
        this.server.register(fastifyIO, {
            // Same decision as the HTTP routes (config/cors.ts), applied to every handshake.
            cors: socketIoCorsOptions,
            allowRequest: socketIoAllowRequest,
            maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
            serverOptions: httpsOptions,
        });
        this.server.ready().then(() => {
            console.log(`Socket Service Initialized`);
            this.io.on(OnEvents.CONNECTION, (socket: Socket) => this.onConnection(socket));
        });
    }

    // Per-connection setup: the live-session entry and every event handler.
    private onConnection(socket: Socket) {
        console.log(`New Connection: ${socket.id}`);
        this._liveSessions.push({
            id: socket.id,
            startTime: Date.now(),
            ip: socket.client.conn.remoteAddress,
        });
        socket.on(OnEvents.DISCONNECT, (reason: string) => this.onDisconnect(socket, reason));
        socket.on(OnEvents.NEW_ORDER, onNewOrder(socket));
        socket.on(OnEvents.UPDATE_ORDERBOOK, onUpdateOrderbook(socket));
        socket.on(OnEvents.CLOSE_ORDER, onClosedOrder(socket));
        socket.on(OnEvents.MANY_ORDERS, onManyOrders(socket));
        socket.on(OnEvents.SWAP, (payload: unknown) => routeSwapEvent(socket, payload));
    }

    // The single disconnect hook: every piece of per-socket state is released here
    // (live-session entry, rate-limit buckets, resting orders). Swap sessions are not
    // per-socket. They end by settlement or timeout, and they reach a socket only
    // through their own registry entry.
    private onDisconnect(socket: Socket, reason: string) {
        this._liveSessions = this._liveSessions.filter(q => q.id !== socket.id);
        releaseSocketLimiters(socket.id);
        orderbookManager.removeOrdersOfSocket(socket.id);
        console.log(`${socket.id} Disconnected! Reason: ${reason}`);
    }
}

const onManyOrders = (socket: Socket) => async (rawOrders: TRawOrder[]) => {
    if (!Array.isArray(rawOrders)) {
        socket.emit(OrderEmitEvents.ERROR, 'Invalid many-orders payload: expected an array of orders');
        return;
    }
    if (rawOrders.length > MAX_BATCH_ORDERS) {
        socket.emit(OrderEmitEvents.ERROR, `Batch too large: ${rawOrders.length} > ${MAX_BATCH_ORDERS}`);
        return;
    }
    for (let i = 0; i < rawOrders.length; i++) {
        if (!orderRateLimiter.consume(socket.id)) {
            // Surface the dropped remainder instead of dropping it silently.
            const dropped = rawOrders.length - i;
            socket.emit(OrderEmitEvents.ERROR, `Rate limit exceeded: dropped ${dropped} of ${rawOrders.length} orders in batch`);
            if (i > 0) socket.emit(OrderEmitEvents.SAVED);
            return;
        }
        const rawOrder = rawOrders[i];
        const factoryRes = orderFactory(rawOrder, socket.id);
        if (factoryRes.error || !factoryRes.data) {
            socket.emit(OrderEmitEvents.ERROR, factoryRes.error || 'Invalid order');
            continue;
        }
        // Every entry gets its result reported; an entry that was not placed is never dropped silently.
        const res = await orderbookManager.addOrder(factoryRes.data, true);
        if (res.error) socket.emit(OrderEmitEvents.ERROR, res.error);
    }
    socket.emit(OrderEmitEvents.SAVED);
}

const onNewOrder = (socket: Socket) => async (rawOrder: TRawOrder) => {
    if (!orderRateLimiter.consume(socket.id)) {
        socket.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    if (!rawOrder || !rawOrder.isLimitOrder) {
        socket.emit(OrderEmitEvents.ERROR, 'Merket Orders Not allowed');
        return;
    }
    const factoryRes = orderFactory(rawOrder, socket.id);
    if (factoryRes.error || !factoryRes.data) {
        socket.emit(OrderEmitEvents.ERROR, factoryRes.error || 'Invalid order');
        return;
    }
    const order: TOrder = factoryRes.data;
    const res = await orderbookManager.addOrder(order);
    console.log('order res '+JSON.stringify(res))
    if (res.error || !res.data) {
        socket.emit(OrderEmitEvents.ERROR, res.error || 'Undifined Error');
        return;
    }

    if (res.data.order){
          socket.emit(OrderEmitEvents.SAVED, res.data.order.uuid);
          const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
          const orderHistory = orderbookManager.getOrdersHistory();
          socket.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
    //socket.emit(events_1.OrderEmitEvents.SAVED, res.data.order.uuid);
    }
};

const onUpdateOrderbook = (socket: Socket) => async (filter: TFilter) => {
    if (!queryRateLimiter.consume(socket.id)) {
        socket.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    const orderbook = orderbookManager.orderbooks.find(e => e.findByFilter(filter))
    const orders = orderbook ? orderbook.orders.filter(o => !o.lock) : [];
    const history = orderbook ? orderbook.historyTrades.filter(o => o.txid) : [];
    socket.emit(EmitEvents.ORDERBOOK_DATA, { orders, history });
};

const onClosedOrder = (socket: Socket) => (orderUUID: string) => {
    console.log('inside onClosedOrder '+orderUUID)
    if (!orderRateLimiter.consume(socket.id)) {
        socket.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    const res = orderbookManager.removeOrder(orderUUID, socket.id);
    const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
    const orderHistory = orderbookManager.getOrdersHistory();
    socket.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
};
