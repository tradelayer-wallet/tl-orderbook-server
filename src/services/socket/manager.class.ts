import { FastifyInstance } from 'fastify';
import { Server, Socket } from 'socket.io';
import { orderbookManager } from '../orderbook';
import { orderFactory } from '../orderbook/order.factory';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { TFilter } from '../../utils/types/markets.types';
import { TOrder, TRawOrder } from '../../utils/types/orderbook.types';

interface IClientSession {
  id: string;
  startTime: number;
  ip: string;
}

/**
 * A singleton SocketManager that can attach to multiple Fastify servers.
 */
export class SocketManager {
  private static _io: Server | null = null;        // The single Socket.IO instance
  private static _liveSessions: IClientSession[] = []; // Keep track of connections

  /**
   * If Socket.IO isn't created yet, create it; otherwise reuse the same instance.
   */
  private static initSocketIO() {
    if (!this._io) {
      this._io = new Server({
        cors: {
          origin: ['https://layerwallet.com', 'https://www.layerwallet.com'],
          methods: ['GET', 'POST'],
          credentials: true,
        },
        transports: ['websocket', 'polling'],
      });

      // Set up the 'connection' event once
      this._io.on(OnEvents.CONNECTION, (socket: Socket) => {
        console.log(`New Connection: ${socket.id}`);
        this.handleConnection(socket);
      });
      console.log('Socket IO created');
    }
  }

  /**
   * Attach our single `io` to any given Fastify server (HTTP or HTTPS).
   */
  public static attachToServer(server: FastifyInstance) {
    this.initSocketIO();
    this._io?.attach(server.server);  // Use the native Node server
    console.log('Socket.IO attached to server:', server.server.address());
  }

  /**
   * Our custom connection handler (extracted from your old code).
   */
  private static handleConnection(socket: Socket) {
    // 1) Track live sessions
    SocketManager._liveSessions.push({
      id: socket.id,
      startTime: Date.now(),
      ip: socket.client.conn.remoteAddress,
    });

    socket.on(OnEvents.DISCONNECT, () => {
      SocketManager._liveSessions = SocketManager._liveSessions.filter(s => s.id !== socket.id);
      console.log(`${socket.id} Disconnected`);
      const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
      openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, socket.id));
    });

    // 2) Hook up your events
    socket.on(OnEvents.NEW_ORDER, this.onNewOrder(socket));
    socket.on(OnEvents.UPDATE_ORDERBOOK, this.onUpdateOrderbook(socket));
    socket.on(OnEvents.CLOSE_ORDER, this.onClosedOrder(socket));
    socket.on(OnEvents.MANY_ORDERS, this.onManyOrders(socket));
  }

  /**
   * The same event callbacks you had before.
   */
  private static onManyOrders = (socket: Socket) => async (rawOrders: TRawOrder[]) => {
    for (const rawOrder of rawOrders) {
      const order: TOrder = orderFactory(rawOrder, socket.id);
      await orderbookManager.addOrder(order, true);
    }
    socket.emit(OrderEmitEvents.SAVED);
  };

  private static onNewOrder = (socket: Socket) => async (rawOrder: TRawOrder) => {
    if (!rawOrder.isLimitOrder) {
      socket.emit(OrderEmitEvents.ERROR, 'Market Orders Not allowed');
      return;
    }
    const order: TOrder = orderFactory(rawOrder, socket.id);
    const res = await orderbookManager.addOrder(order);
    console.log('order res ' + JSON.stringify(res));
    if (res.error || !res.data) {
      socket.emit(OrderEmitEvents.ERROR, res.error || 'Undefined Error');
      return;
    }
    if (res.data.order) {
      console.log(`Inside the if res.data.order block. Socket ID: ${socket.id}`);
      socket.emit(OrderEmitEvents.SAVED, res.data.order.uuid);

      const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
      const orderHistory = orderbookManager.getOrdersHistory();
      socket.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
    }
  };

  private static onUpdateOrderbook = (socket: Socket) => async (filter: TFilter) => {
    const orderbook = orderbookManager.orderbooks.find((e) => e.findByFilter(filter));
    const orders = orderbook ? orderbook.orders.filter((o) => !o.lock) : [];
    const history = orderbook ? orderbook.historyTrades.filter((o) => o.txid) : [];
    socket.emit(EmitEvents.ORDERBOOK_DATA, { orders, history });
  };

  private static onClosedOrder = (socket: Socket) => (orderUUID: string) => {
    orderbookManager.removeOrder(orderUUID, socket.id);
    const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
    const orderHistory = orderbookManager.getOrdersHistory();
    socket.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
  };

  // Optional helper getters if needed
  public static get io(): Server | null {
    return this._io;
  }
  public static get liveSessions(): IClientSession[] {
    return this._liveSessions;
  }
}
