// src/services/orderbook/orderbook.class.ts
// Back-compat wrapper around the Rust NAPI module.
// Works with manager.class.ts and socket/manager.class.ts as-is.

import * as native from '../../rust/matcher-core/matcher_core.node';

export type TOrder = {
  uuid: string;
  side: 'BUY' | 'SELL';
  price: number;
  amount: number;
  socket_id?: string;
  // keep optional to satisfy callers that check it:
  lock?: boolean;
};

type ConstructArg = string | (Partial<TOrder> & { marketKey?: string; symbol?: string });

function inferSymbol(arg: ConstructArg): string {
  if (typeof arg === 'string') return arg;
  // common keys your code may pass down
  if (arg.marketKey && typeof arg.marketKey === 'string') return arg.marketKey;
  if (arg.symbol && typeof arg.symbol === 'string') return arg.symbol;
  // nothing obvious? fall back to a generic book name
  return 'DEFAULT';
}

export class Orderbook {
  public orderbookName: string;
  public orders: TOrder[] = [];
  public historyTrades: any[] = [];

  // Accept either a symbol or an order (for legacy: new Orderbook(firstOrder))
  constructor(arg: ConstructArg) {
    this.orderbookName = inferSymbol(arg).toUpperCase();
    native.createBook(this.orderbookName);
  }

  dispose() { native.dropBook(this.orderbookName); }

  /** Legacy hook used by manager to pick an existing book */
  public checkCompatible(order: { marketKey?: string; symbol?: string }): boolean {
    const want = inferSymbol(order).toUpperCase();
    return want === this.orderbookName;
  }

  /** Legacy helper used elsewhere */
  public findByFilter(filter: string): boolean {
    return this.orderbookName.toLowerCase().includes((filter ?? '').toLowerCase());
  }

  /** Legacy helper (no-op; bookkeeping can live in the Rust side later) */
  public updatePlacedOrdersForSocketId(_socketId?: string): void {}

  /** Submit one order; ignore noTrades flag (not supported by core yet) */
  public addOrder(order: TOrder, _noTrades?: boolean) {
    return native.submit(this.orderbookName, order);
  }

  /** Batch submit; matches native shape */
  public addOrdersBatch(orders: TOrder[]) {
    return native.submitBatch(this.orderbookName, orders);
  }

  /** Cancel one order; keep optional socket_id param for compatibility */
  public removeOrder(orderId: string, _socket_id?: string) {
    return native.cancel(this.orderbookName, orderId);
  }

  /** Cancel all orders tied to a socket */
  public cancelAllBySocket(socketId: string) {
    return native.cancelAllBySocket(this.orderbookName, socketId);
  }

  /** Pull snapshot and materialize .orders so callers can read them */
  public refresh(depth: number = 20): void {
    const json = native.snapshot(this.orderbookName, depth);
    try {
      const snap = JSON.parse(json);

      const bids: TOrder[] = Object.values(snap.bids ?? {}).flatMap((lvl: any) =>
        (lvl.orders ?? []).map((o: any) => ({
          uuid: o.id ?? '',
          side: 'BUY',
          price: lvl.price ?? 0,
          amount: o.quantity ?? 0,
          lock: false,
        })),
      );

      const asks: TOrder[] = Object.values(snap.asks ?? {}).flatMap((lvl: any) =>
        (lvl.orders ?? []).map((o: any) => ({
          uuid: o.id ?? '',
          side: 'SELL',
          price: lvl.price ?? 0,
          amount: o.quantity ?? 0,
          lock: false,
        })),
      );

      this.orders = [...bids, ...asks];
    } catch (e) {
      console.error(`snapshot parse failed for ${this.orderbookName}`, e);
      this.orders = [];
    }
  }

  /** Direct JSON helpers (safe to call) */
  public snapshot(depth: number = 20): any {
    try { return JSON.parse(native.snapshot(this.orderbookName, depth)); }
    catch { return {}; }
  }

  public stats(): any {
    try { return JSON.parse(native.stats(this.orderbookName)); }
    catch { return {}; }
  }
}
