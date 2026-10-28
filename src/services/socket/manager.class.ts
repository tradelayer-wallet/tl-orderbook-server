import * as fs from 'fs';
import { FastifyInstance } from "fastify";
import { Server, Socket } from "socket.io";
import { socketIoAllowRequest, socketIoCorsOptions } from "../../config/cors";
import { envConfig } from "../../config/env.config";
import { TOrder } from "../../utils/types/orderbook.types";
import { orderbookManager } from "../orderbook";
import { parseCloseOrder, parseNewOrder, parseOrderFilter } from "../../protocol/messages";
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

    // The one admission decision for a new socket: at most MAX_CONNECTIONS_PER_IP live sockets per address.
    private admitConnection(ip: string): boolean {
        return this._liveSessions.filter(s => s.ip === ip).length < envConfig.MAX_CONNECTIONS_PER_IP;
    }

    // Per-connection setup: the live-session entry and every event handler. A socket that is not
    // admitted gets neither, so it holds no state the disconnect hook would have to release.
    private onConnection(socket: Socket) {
        const ip = socket.client.conn.remoteAddress;
        if (!this.admitConnection(ip)) {
            console.log(`${socket.id} refused: too many connections from this address`);
            socket.emit(OrderEmitEvents.ERROR, 'Too many connections from this address');
            socket.disconnect();
            return;
        }
        console.log(`New Connection: ${socket.id}`);
        this._liveSessions.push({
            id: socket.id,
            startTime: Date.now(),
            ip,
        });
        // Every client event goes through guarded(): nothing in this process catches a throw
        // or a rejection from a listener, so one bad payload would take the whole server down.
        socket.on(OnEvents.DISCONNECT, guarded(socket, OnEvents.DISCONNECT, (reason: string) => this.onDisconnect(socket, reason)));
        socket.on(OnEvents.NEW_ORDER, guarded(socket, OnEvents.NEW_ORDER, onNewOrder(socket)));
        socket.on(OnEvents.UPDATE_ORDERBOOK, guarded(socket, OnEvents.UPDATE_ORDERBOOK, onUpdateOrderbook(socket)));
        socket.on(OnEvents.CLOSE_ORDER, guarded(socket, OnEvents.CLOSE_ORDER, onClosedOrder(socket)));
        socket.on(OnEvents.MANY_ORDERS, guarded(socket, OnEvents.MANY_ORDERS, onManyOrders(socket)));
        socket.on(OnEvents.SWAP, guarded(socket, OnEvents.SWAP, (payload: unknown) => routeSwapEvent(socket, payload)));
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

// Wraps one client event handler. A synchronous throw and a rejected promise both end up here:
// the failure is logged without any payload, the sender gets a refusal, and the server keeps
// running. Nothing else in this process would catch them.
const guarded = (socket: Socket, name: string, handler: (...args: any[]) => unknown) =>
    (...args: any[]): void => {
        const refuse = (error: unknown) => {
            console.log(`${socket.id} ${name} refused: ${(error as Error)?.message || 'handler failed'}`);
            if (socket.connected) socket.emit(OrderEmitEvents.ERROR, 'Internal error: request refused');
        };
        try {
            const result = handler(...args);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
                (result as Promise<unknown>).catch(refuse);
            }
        } catch (error) {
            refuse(error);
        }
    };

// Admits one event from the socket's limit of a traffic family, or tells the sender it was refused.
const admit = (socket: Socket, limiter: { consume(key: string): boolean }): boolean => {
    if (limiter.consume(socket.id)) return true;
    socket.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
    return false;
};

const onManyOrders = (socket: Socket) => async (rawOrders: unknown[]) => {
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
        const parsed = parseNewOrder(rawOrders[i], socket.id);
        if (parsed.error || !parsed.data) {
            socket.emit(OrderEmitEvents.ERROR, parsed.error || 'Invalid order');
            continue;
        }
        // Each entry is applied on its own (the batch is not atomic): an entry that
        // is refused is reported with its own error, and entries placed before it
        // stay on the book. The client's book view is refreshed by PLACED_ORDERS for
        // every placed entry. SAVED marks the end of the batch, not success of all.
        const res = await orderbookManager.addOrder(parsed.data, true);
        if (res.error) socket.emit(OrderEmitEvents.ERROR, res.error);
    }
    socket.emit(OrderEmitEvents.SAVED);
}

const onNewOrder = (socket: Socket) => async (rawOrder: unknown) => {
    if (!admit(socket, orderRateLimiter)) return;
    const parsed = parseNewOrder(rawOrder, socket.id);
    if (parsed.error || !parsed.data) {
        socket.emit(OrderEmitEvents.ERROR, parsed.error || 'Invalid order');
        return;
    }
    const order: TOrder = parsed.data;
    const res = await orderbookManager.addOrder(order);
    // No logging of the order or result here: they carry the keypair address and pubkey.
    if (res.error || !res.data) {
        socket.emit(OrderEmitEvents.ERROR, res.error || 'Undifined Error');
        return;
    }

    if (res.data.order){
          socket.emit(OrderEmitEvents.SAVED, res.data.order.uuid);
          socket.emit(EmitEvents.PLACED_ORDERS, orderbookManager.placedOrdersOf(socket.id));
    }
};

const onUpdateOrderbook = (socket: Socket) => (rawFilter: unknown) => {
    if (!admit(socket, queryRateLimiter)) return;
    const filter = parseOrderFilter(rawFilter);
    if (filter.error || !filter.data) {
        socket.emit(OrderEmitEvents.ERROR, filter.error);
        return;
    }
    socket.emit(EmitEvents.ORDERBOOK_DATA, orderbookManager.marketView(filter.data));
};

const onClosedOrder = (socket: Socket) => (rawUuid: unknown) => {
    if (!admit(socket, orderRateLimiter)) return;
    const orderUUID = parseCloseOrder(rawUuid);
    if (orderUUID.error || !orderUUID.data) {
        socket.emit(OrderEmitEvents.ERROR, orderUUID.error);
        return;
    }
    // Client-initiated cancel: the default (duringSettlement=false) refuses an order
    // that a swap currently has locked.
    const res = orderbookManager.removeOrder(orderUUID.data, socket.id);
    if (res.error) socket.emit(OrderEmitEvents.ERROR, res.error);
    socket.emit(EmitEvents.PLACED_ORDERS, orderbookManager.placedOrdersOf(socket.id));
};
