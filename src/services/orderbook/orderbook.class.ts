// packages/wallet-server/src/services/orderbook/orderbook.class.ts
// Keep this filename/class so callers don't change.
import * as native from '@/rust/matcher-core/matcher_core.node';
// If your TS config doesn't define `@` -> `./src`, use:
// import * as native from '../../rust/matcher-core/matcher_core.node';

export type TOrder = {
  uuid: string;
  side: 'BUY' | 'SELL';
  price: number;
  amount: number;
  socket_id?: string;
};

export class Orderbook {
  public orderbookName: string;
  public orders: TOrder[] = [];
  public historyTrades: any[] = []; // can be filled later if you expose native.history(symbol)

  constructor(private symbol: string) {
    this.orderbookName = symbol.toUpperCase();
    // camelCase NAPI export:
    native.createBook(this.orderbookName);
  }

  dispose() {
    native.dropBook(this.orderbookName);
  }

  /** legacy helper expected by callers */
  public findByFilter(filter: string): boolean {
    return this.orderbookName.toLowerCase().includes(filter.toLowerCase());
  }

  /** legacy helper expected by callers (no-op here, bookkeeping happens server-side) */
  public updatePlacedOrdersForSocketId(_socketId: string): void {
    // intentionally left blank for compatibility
  }

  /** Submit one order via Rust core */
  public addOrder(o: TOrder) {
    // native.submit(symbol, order)
    return native.submit(this.orderbookName, o);
  }

  /** Batch submit via Rust core */
  public addOrdersBatch(os: TOrder[]) {
    // native.submitBatch(symbol, orders)
    return native.submitBatch(this.orderbookName, os);
  }

  /** Cancel one order */
  public removeOrder(orderId: string) {
    // native.cancel(symbol, orderId)
    return native.cancel(this.orderbookName, orderId);
  }

  /** Cancel all orders tied to a socket */
  public cancelAllBySocket(socketId: string) {
    // native.cancelAllBySocket(symbol, socketId)
    return native.cancelAllBySocket(this.orderbookName, socketId);
  }

  /** Pull a fresh snapshot and materialize .orders for downstream code */
  public refresh(depth: number = 20): void {
    const json = native.snapshot(this.orderbookName, depth);
    try {
      const snap = JSON.parse(json);

      // Flatten levels into simple order rows compatible with prior code.
      const bids: TOrder[] = Object.values(snap.bids ?? {}).flatMap((lvl: any) =>
        (lvl.orders ?? []).map((o: any) => ({
          uuid: o.id ?? '',
          side: 'BUY',
          price: lvl.price ?? 0,
          amount: o.quantity ?? 0,
        })),
      );

      const asks: TOrder[] = Object.values(snap.asks ?? {}).flatMap((lvl: any) =>
        (lvl.orders ?? []).map((o: any) => ({
          uuid: o.id ?? '',
          side: 'SELL',
          price: lvl.price ?? 0,
          amount: o.quantity ?? 0,
        })),
      );

      this.orders = [...bids, ...asks];
      // historyTrades: keep empty unless you expose a native.history(symbol)
    } catch (e) {
      console.error(`snapshot parse failed for ${this.orderbookName}`, e);
      this.orders = [];
    }
  }

  /** Direct accessors if you need them */
  public snapshot(depth: number = 20): any {
    try {
      return JSON.parse(native.snapshot(this.orderbookName, depth));
    } catch {
      return {};
    }
  }

  public stats(): any {
    try {
      return JSON.parse(native.stats(this.orderbookName));
    } catch {
      return {};
    }
  }
}
