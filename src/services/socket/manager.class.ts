import { FastifyInstance } from "fastify";
import { Server, Socket } from "socket.io";
import { socketService } from ".";
import { TFilter } from "../../utils/types/markets.types";
import { EOrderType, TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { orderbookManager } from "../orderbook";
import { orderFactory } from "../orderbook/order.factory";
import { EmitEvents, OnEvents, OrderEmitEvents } from "./events";

export class SocketManager {
    constructor(
        private server: FastifyInstance,
    ) {
        this.initService();
    }

    get io(): Server {
        return this.server['io'];
    }

    private initService() {
        const fastifyIO = require("fastify-socket.io");
        this.server.register(fastifyIO);
        this.server.ready().then(() => {
            console.log(`Socket Service Initialized`);
            this.io.on(OnEvents.CONNECTION, onConnection);

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
    if (res.error || !res.data) {
        socket.emit(OrderEmitEvents.ERROR, res.error || 'Undifined Error');
        return;
    }

    if (res.data.order) socket.emit(OrderEmitEvents.SAVED, res.data.order.uuid);
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
    socket.emit(EmitEvents.PLACED_ORDERS, openedOrders);
};

