// src/services/orderbook/orderbook.class.ts
import * as native from '../../../rust/matcher-core/matcher_core.node';

// Minimal shape the Rust core expects
type NativeOrder = {
  uuid: string;
  side: 'BUY' | 'SELL';
  price: number;
  amount: number;
  socket_id?: string;
};

type ConstructArg = string | { marketKey?: string; symbol?: string } | Record<string, any>;

function inferSymbol(arg: ConstructArg): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') {
    if (typeof (arg as any).marketKey === 'string') return (arg as any).marketKey!;
    if (typeof (arg as any).symbol === 'string') return (arg as any).symbol!;
  }
  return 'DEFAULT';
}

function normSide(x: any): 'BUY' | 'SELL' {
  const s =
    (x?.side ?? x?.action ?? x?.orderSide ?? '').toString().toLowerCase();
  return s === 'buy' ? 'BUY' : 'SELL';
}
function num(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeOrder(o: any): NativeOrder {
  return {
    uuid:
      (o?.uuid ?? o?.id ?? o?.orderId ?? o?.clientOrderId ?? o?.cid ?? '').toString(),
    side: normSide(o),
    price: num(o?.price ?? o?.price_num ?? o?.px),
    amount: num(o?.amount ?? o?.qty ?? o?.quantity ?? o?.size),
    socket_id: o?.socket_id ?? o?.socketId,
  };
}

export class Orderbook {
  public orderbookName: string;
  // keep these very loose so manager/socket code can stuff their own shapes
  public orders: any[] = [];
  public historyTrades: any[] = [];
  
  constructor(arg: ConstructArg) {
    this.orderbookName = inferSymbol(arg).toUpperCase();
    native.createBook(this.orderbookName);
  }

  // server-side owner index for resting orders
  const ownerByOrderId = new Map<string, string>();
  export public rememberOwner(orderId: string, socketId?: string) {
    if (orderId && socketId) ownerByOrderId.set(orderId, socketId);
  }
  export public forgetOwner(orderId: string) {
    if (orderId) ownerByOrderId.delete(orderId);
  }
  export public ownerOf(orderId: string): string | undefined {
    return ownerByOrderId.get(orderId);
  }

  public opposite(side: 'BUY'|'SELL'): 'BUY'|'SELL' { return side === 'BUY' ? 'SELL' : 'BUY'; }

// Heuristic: when the maker isn’t fully removed (no id in filled_order_ids),
// look up the current FIFO top at that price on the maker side.
export public findMakerOrderIdFromSnapshot(obSymbol: string, makerSide: 'BUY'|'SELL', price: number): string | undefined {
  try {
    const depth = 20; // plenty for best level
    const snap = JSON.parse(native.snapshot(obSymbol, depth));
    const book = snap?.snapshot;
    const levels = (makerSide === 'BUY' ? book?.bids : book?.asks) || [];
    const lvl = levels.find((l: any) => l.price === price);
    if (!lvl) return;
    // FIFO: first order on that level is the maker currently at top
    const first = lvl.orders?.[0];
    if (!first) return;
    const id = first.Standard?.id ?? first?.id;
    return id;
  } catch { return; }
}

  dispose() { native.dropBook(this.orderbookName); }

  // Manager calls this with ISpotOrder; accept anything.
  public checkCompatible(order: any): boolean {
    const want = inferSymbol(order).toUpperCase();
    return want === this.orderbookName;
  }

  public findByFilter(filter: string): boolean {
    return this.orderbookName.toLowerCase().includes((filter ?? '').toLowerCase());
  }

  public updatePlacedOrdersForSocketId(_socketId?: string): void {}

  // Accept anything and normalize for Rust
  public addOrder(order: any, _noTrades?: boolean) {
    if (order?.uuid && order?.socket_id) {
      rememberOwner(order.uuid, order.socket_id);
    }
    const res = native.submit(this.orderbookName, normalizeOrder(order));
    return typeof res === 'string' ? JSON.parse(res) : res;
  }

  public addOrdersBatch(orders: any[]) {
    // addOrdersBatch(...)
    orders.forEach(o => { if (o?.uuid && o?.socket_id) rememberOwner(o.uuid, o.socket_id); });
    const res = native.submitBatch(this.orderbookName, orders.map(normalizeOrder));
    return typeof res === 'string' ? JSON.parse(res) : res;
  }

  public removeOrder(orderId: string, _socket_id?: string) {
    return native.cancel(this.orderbookName, orderId);
  }

  public cancelAllBySocket(socketId: string) {
    return native.cancelAllBySocket(this.orderbookName, socketId);
  }

  public refresh(depth: number = 20): void {
    const json = native.snapshot(this.orderbookName, depth);
    try {
      const snap = JSON.parse(json);
      const toList = (levels: any, side: 'BUY' | 'SELL') =>
        Object.values(levels ?? {}).flatMap((lvl: any) =>
          (lvl.orders ?? []).map((o: any) => ({
            uuid: o.id ?? '',
            side,
            price: lvl.price ?? 0,
            amount: o.quantity ?? 0,
            lock: false,
          })),
        );
      this.orders = [...toList(snap.bids, 'BUY'), ...toList(snap.asks, 'SELL')];
    } catch {
      this.orders = [];
    }
  }

  public snapshot(depth: number = 20): any {
    try { return JSON.parse(native.snapshot(this.orderbookName, depth)); }
    catch { return {}; }
  }
  public stats(): any {
    try { return JSON.parse(native.stats(this.orderbookName)); }
    catch { return {}; }
  }
}
