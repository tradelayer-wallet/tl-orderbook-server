import fs from 'fs';
import { FastifyInstance } from "fastify";
import { Server, Socket } from "socket.io";
import { TFilter } from "../../utils/types/markets.types";
import { TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";

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
            cors: {
                origin: ["https://layerwallet.com", "https://www.layerwallet.com"], // Web origins allowed "https://layerwallet.com", "https://www.layerwallet.com", "http://localhost:4200",
                methods: ["GET", "POST"], // Allowed HTTP methods
                credentials: true, // Allow cookies/auth headers
            },
            serverOptions: httpsOptions,
        });
        this.server.ready().then(() => {
            console.log(`Socket Service Initialized`);
            this.io.on(OnEvents.CONNECTION, onConnection);
            this.io.on(OnEvents.CONNECTION, this.handleLiveSessions.bind(this));
        });
    }

    handleLiveSessions(socket: Socket) {
        this._liveSessions.push({
            id: socket.id,
            startTime: Date.now(),
            ip: socket.client.conn.remoteAddress,
        });
        socket.on(OnEvents.DISCONNECT, () => {
            this._liveSessions = this._liveSessions.filter(q => q.id !== socket.id);
        });
    }
}

const onConnection = (socket: Socket) => {
    console.log(`New Connection: ${socket.id}`);
    socket.on(OnEvents.DISCONNECT, onDisconnect(socket));
    socket.on(OnEvents.NEW_ORDER, onNewOrder(socket));
    socket.on(OnEvents.UPDATE_ORDERBOOK, onUpdateOrderbook(socket));
    socket.on(OnEvents.CLOSE_ORDER, onClosedOrder(socket));
    socket.on(OnEvents.MANY_ORDERS, onManyOrders(socket));
}

const onManyOrders = (socket: Socket) => async (rawOrders: TRawOrder[]) => {
    for (let i = 0; i < rawOrders.length; i++) {
        const rawOrder = rawOrders[i];
        const order: TOrder = orderFactory(rawOrder, socket.id);
        await orderbookManager.addOrder(order, true);
    }
    socket.emit(OrderEmitEvents.SAVED);
}

const onDisconnect = (socket: Socket) => (reason: string) => {
    const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
    openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, socket.id));
    console.log(`${socket.id} Disconnected! Reason: ${reason}`);
};

const onNewOrder = (socket: Socket) => async (rawOrder: TRawOrder) => {
    if (!rawOrder.isLimitOrder) {
        socket.emit(OrderEmitEvents.ERROR, 'Merket Orders Not allowed');
        return;
    }
    const order: TOrder = orderFactory(rawOrder, socket.id);
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
    const orderbook = orderbookManager.orderbooks.find(e => e.findByFilter(filter))
    const orders = orderbook ? orderbook.orders.filter(o => !o.lock) : [];
    const history = orderbook ? orderbook.historyTrades.filter(o => o.txid) : [];
    socket.emit(EmitEvents.ORDERBOOK_DATA, { orders, history });
};

const onClosedOrder = (socket: Socket) => (orderUUID: string) => {
    const res = orderbookManager.removeOrder(orderUUID, socket.id);
    const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
    const orderHistory = orderbookManager.getOrdersHistory();
    socket.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
};

