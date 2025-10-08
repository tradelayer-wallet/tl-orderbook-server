// OrderbookManager with zero public EventEmitter.
// It calls SocketManager via ISocketNotifier to fan-out events.
// Cancels are O(1) via uuid->book index.
// Snapshots: only `native` goes over the high-frequency path.

import { ISocketNotifier } from '../socket/manager.class';
import type { Orderbook } from './orderbook.class'; // your existing class
// import native bindings as needed
// import { native } from '../native'; // example

type TOrder = {
  uuid: string;
  socket_id: string;
  marketKey: string;
  // ... your other fields (price, qty, side, etc.)
};
type IResult<T=any> = { data?: T; error?: string };

export class OrderbookManager {
  public orderbooks: Orderbook[] = [];

  private byMarket = new Map<string, Orderbook>(); // marketKey -> book
  private byUuid   = new Map<string, Orderbook>(); // order uuid -> book

  // snap pacing
  private lastSnapTs = new Map<string, number>();
  private snapMinIntervalMs = 75;

  constructor(private notify: ISocketNotifier) {}

  getBook(marketKey: string): Orderbook | undefined {
    return this.byMarket.get(marketKey);
  }

  // Create or reuse book and add order
  async addOrder(order: TOrder, noTrades = false): Promise<IResult> {
    try {
      let book = this.byMarket.get(order.marketKey);
      if (!book) {
        book = new (require('./orderbook.class').Orderbook)(order);
        this.orderbooks.push(book);
        this.byMarket.set(order.marketKey, book);
        // seed uuid index
        for (const o of book.orders) this.byUuid.set(o.uuid, book);
      }

      const raw = await book.addOrder(order, noTrades);
      // update uuid index optimistically
      if (!('error' in raw)) this.byUuid.set(order.uuid, book);

      // report executions to the two sockets (orderbook should expose them or return from addOrder)
      // Example, if book.addOrder returns { transactions, maker_socket_id, taker_socket_id }:
      const txns = (raw?.data?.trade?.transactions) ?? [];
      for (const t of txns) this.emitExecution(book, t);

      // snapshot throttle
      this.tryBroadcastSnapshot(book);

      return raw;
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  }

  removeOrder(uuid: string, socket_id: string): IResult {
    try {
      const book = this.byUuid.get(uuid) || null;
      if (!book) throw new Error(`Order with uuid: ${uuid} not found`);
      const res = book.removeOrder(uuid, socket_id);
      this.byUuid.delete(uuid);

      // inform the socket that its order is closed
      this.notify.toSocketId(socket_id, {
        event: 'close-order',
        data: { orderUuid: uuid, marketKey: book.orderbookName, socketId: socket_id }
      });

      // small snapshot after change
      this.tryBroadcastSnapshot(book);

      return res;
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  }

  // Optional: fast cancel all by socket (call from SocketManager on ws close)
  cancelAllBySocket(socketId: string) {
    for (const book of this.orderbooks) {
      try {
        // native.cancel_all_by_socket(book.orderbookName, socketId);
        // If JS-side needed:
        const victims = book.orders.filter(o => o.socket_id === socketId);
        for (const v of victims) {
          try { book.removeOrder(v.uuid, socketId); this.byUuid.delete(v.uuid); } catch {}
        }
        if (victims.length) this.tryBroadcastSnapshot(book);
      } catch {}
    }
  }

  // === Private helpers =======================================================

  private emitExecution(book: Orderbook, txn: any) {
    // Expect your book to tell you maker/taker socket ids per trade leg.
    const makerId = txn?.maker_socket_id;
    const takerId = txn?.taker_socket_id;

    const payload = { event: 'execution', data: { marketKey: book.orderbookName, txn } };
    if (makerId) this.notify.toSocketId(makerId, payload);
    if (takerId) this.notify.toSocketId(takerId, payload);
  }

  private tryBroadcastSnapshot(book: Orderbook) {
    const mk = book.orderbookName;
    const now = Date.now();
    const last = this.lastSnapTs.get(mk) ?? 0;
    if (now - last < this.snapMinIntervalMs) return;
    this.lastSnapTs.set(mk, now);

    // keep payload small: send only native snapshot; FE can render BBO/levels
    const nativeSnap = book.snapshotNative(50);
    this.notify.toMarket(mk, {
      event: 'orderbook-data',
      marketKey: mk,
      native: nativeSnap
    });
  }
}
