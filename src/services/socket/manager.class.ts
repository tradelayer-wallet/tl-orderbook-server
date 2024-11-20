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
        const fastifyIO = require("fastify-socket.io");
        this.server.register(fastifyIO);
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

     // Adjust incorrect parameter mismatches
    if (order.type === 'SPOT') {
        const { id_for_sale, id_desired, action } = order.props;

        // Automatically adjust action for SELL orders if id_for_sale <= id_desired
        if (action === 'SELL' && id_for_sale <= id_desired) {
            order.props.action = 'BUY'; // Change to BUY action if mismatch
            socket.emit(OrderEmitEvents.INFO, 'SELL order mismatch: Automatically changed to BUY');
        }

        // Automatically adjust action for BUY orders if id_for_sale >= id_desired
        if (action === 'BUY' && id_for_sale >= id_desired) {
            order.props.action = 'SELL'; // Change to SELL action if mismatch
            socket.emit(OrderEmitEvents.INFO, 'BUY order mismatch: Automatically changed to SELL');
        }
    }

    const order: TOrder = orderFactory(rawOrder, socket.id);
    const res = await orderbookManager.addOrder(order);
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

