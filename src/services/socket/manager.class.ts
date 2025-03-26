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

export class SocketManager {
  private static _io: Server | null = null;        // The single Socket.IO instance
  private static _liveSessions: IClientSession[] = []; // Keep track of connections
  private static _initialized = false;            // Track initialization

  /**
   * Initialize the SocketManager with the provided Fastify servers.
   * This ensures Socket.IO is properly set up before any usage.
   */
  public static async init(servers: FastifyInstance[]): Promise<void> {
    if (this._initialized) {
      throw new Error('SocketManager is already initialized.');
    }

    // Create the Socket.IO instance
    this._io = new Server({
      cors: {
        origin: ['https://layerwallet.com', 'https://www.layerwallet.com'],
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    // Attach the Socket.IO instance to each provided server
    servers.forEach((server) => {
      this._io?.attach(server.server);
      //console.log(`Socket.IO attached to server on port ${server.server.address().port}`);
    });

    // Set up the 'connection' event once
    this._io.on(OnEvents.CONNECTION, (socket: Socket) => {
      console.log(`New Connection: ${socket.id}`);
      this.handleConnection(socket);
    });

    this._initialized = true;
    console.log('SocketManager initialized.');
  }

  /**
   * Handle a new connection. This centralizes all Socket.IO event handling logic.
   */
  private static handleConnection(socket: Socket) {
    this._liveSessions.push({
      id: socket.id,
      startTime: Date.now(),
      ip: socket.client.conn.remoteAddress,
    });

    socket.on(OnEvents.DISCONNECT, () => {
      this._liveSessions = this._liveSessions.filter(s => s.id !== socket.id);
      console.log(`${socket.id} Disconnected`);
      const openedOrders = orderbookManager.getOrdersBySocketId(socket.id);
      openedOrders.forEach(o => orderbookManager.removeOrder(o.uuid, socket.id));
    });

    // Event handlers
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
    console.log('yah')
    const order: TOrder = orderFactory(rawOrder, socket.id);
    console.log(JSON.stringify(order))
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
