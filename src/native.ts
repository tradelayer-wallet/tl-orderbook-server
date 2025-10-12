// src/native.ts
/* eslint-disable @typescript-eslint/no-var-requires */
import path from 'node:path';

// ---------- dynamic loader ----------
function loadNative() {
  const candidates = [
    // local Rust workspace build (what you showed in screenshots)
    path.join(__dirname, '..', 'rust', 'matcher-core', 'matcher_core.node'),
  ];
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  throw new Error('Cannot load native addon (matcher-core.node). Tried: ' + candidates.join(' , '));
}

function assertFn(fn: any, name: string) {
  if (typeof fn !== 'function') {
    throw new Error(`native export missing: ${name}`);
  }
}

const nat = loadNative();

// ---------- types used by TS callers ----------
export type JsOrder = {
  uuid: string;
  price: number;
  amount: number;
  side: 'BUY' | 'SELL';
  socket_id?: string;
  type?: 'SPOT' | 'FUTURES';
  action?: 'BUY' | 'SELL';
  props?: any;
  keypair?: any;
};

export type Exec = {
  price: number;
  quantity: number;
  maker_socket_id?: string;
  taker_socket_id?: string;
  maker_ext_uuid?: string;
  taker_ext_uuid?: string;
};

type Handlers = {
  onExecs?: (market: string, execs: Exec[]) => void | Promise<void>;
  onSnapshot?: (market: string, snapshot: any) => void | Promise<void>;
  onOrderEvent?: (ev: {
    type: 'ADDED' | 'CANCELED' | 'AMENDED';
    market: string;
    uuid: string;
    socket_id?: string;
    price?: number;
    quantity?: number;
  }) => void | Promise<void>;
};

// ---------- optional event sinks from the app ----------
let H: Handlers = {};
export const registerNativeSinks = (h: Handlers) => { H = h || {}; };

// ---------- safe helpers ----------
function tryParse(jsonLike: any): any {
  if (jsonLike == null) return {};
  if (typeof jsonLike === 'object') return jsonLike;
  if (typeof jsonLike === 'string') {
    try { return JSON.parse(jsonLike); } catch { return {}; }
  }
  return {};
}

// ---------- public shim ----------
export const native = {
  // engine/bootstrap
  init_market: (market: string) => nat.init_market?.(market),
  set_stpf_policy: (market: string, policy: 'neutralize_taker' | 'maker_bump') =>
    nat.set_stpf_policy?.(market, policy),

  // book readouts
  snapshot: (market: string, levels?: number) =>
    nat.snapshot?.(market, levels ?? 50),

  get_open_orders_by_socket: (socketId: string, market?: string): string =>
    nat.getOpenOrdersBySocket?.(socketId, market) ?? '[]',

  getOrderHistoryBySocket: (socketId: string, market: string, limit?: number): string =>
    (nat as any).getOrderHistoryBySocket?.(market, socketId, limit ?? 200) ?? '[]',

    cancel_all_by_socket: (market: string, socketId: string): number => {
      const fn = (nat as any).cancelAllBySocket;   // no optional chaining
      assertFn(fn, 'cancelAllBySocket');
      return fn(market, socketId);
    },

    cancel_all_by_socket_global: (socketId: string): number => {
      const fn = (nat as any).cancelAllBySocketGlobal;  // no optional chaining
      assertFn(fn, 'cancelAllBySocketGlobal');
      return fn(socketId);
    },

  // single ops
  submit: (market: string, order: JsOrder) => {
    const raw = nat.submit(market, order) as unknown;
    const obj = tryParse(raw);

    // map maker_slices/execs → Exec[]
    const makerSlices: any[] = Array.isArray(obj?.maker_slices) ? obj.maker_slices : [];
    const execsArr: any[] = Array.isArray(obj?.execs) ? obj.execs : [];
    const execs: Exec[] = [
      ...makerSlices.map((m: any) => ({
        price: Number(m.price),
        quantity: Number(m.quantity),
        maker_socket_id: m.maker_socket_id,
        taker_socket_id: m.taker_socket_id,
        maker_ext_uuid: m.maker_ext_uuid,
        taker_ext_uuid: m.taker_ext_uuid,
      })),
      ...execsArr.map((e: any) => ({
        price: Number(e.price),
        quantity: Number(e.quantity),
        maker_socket_id: e.maker_socket_id,
        taker_socket_id: e.taker_socket_id,
        maker_ext_uuid: e.maker_ext_uuid,
        taker_ext_uuid: e.taker_ext_uuid,
      })),
    ];

    if (execs.length) H.onExecs?.(market, execs);

    // if remainder rests, emit ADDED so wallet tray updates
    const remained = Number(obj.remaining_qty || 0) > 0 && obj.is_complete === false;
    if (remained) {
      H.onOrderEvent?.({
        type: 'ADDED',
        market,
        uuid: order.uuid,
        socket_id: order.socket_id,
        price: order.price,
        quantity: Number(obj.remaining_qty) || order.amount,
      });
    }

    return obj; // keep original shape for callers that read fields
  },

  cancel: (market: string, uuid: string): boolean => {
    const ok = Boolean(nat.cancel?.(market, uuid));
    if (ok) H.onOrderEvent?.({ type: 'CANCELED', market, uuid });
    return ok;
  },

  // guard: some builds won’t expose edit; fall back to false
  edit: (market: string, uuid: string, newQty?: number, newPrice?: number): boolean => {
    if (typeof nat.edit !== 'function') return false;
    const ok = Boolean(nat.edit(market, uuid, newQty, newPrice));
    if (ok) H.onOrderEvent?.({ type: 'AMENDED', market, uuid, quantity: newQty, price: newPrice });
    return ok;
  },

  // batch (optional)
  submit_batch: (req: {
    market: string;
    cancel?: string[];
    amend?: { uuid: string; new_quantity: number; new_price?: number }[];
    place?: JsOrder[];
    snap_levels?: number;
  }) => {
    if (typeof nat.submit_batch !== 'function') {
      // polyfill by issuing singles
      const placed: string[] = [];
      const canceled: string[] = [];
      for (const c of req.cancel || []) {
        if (native.cancel(req.market, c)) canceled.push(c);
      }
      for (const p of req.place || []) {
        const r = native.submit(req.market, p);
        if (r?.placed !== false) placed.push(p.uuid);
      }
      const snapshot = native.snapshot(req.market, req.snap_levels);
      return { placed, canceled, snapshot };
    }

    const res = nat.submit_batch(req) as unknown;
    const obj = tryParse(res);

    if (Array.isArray(obj.execs) && obj.execs.length) {
      H.onExecs?.(req.market, obj.execs);
    }
    if (obj.snapshot) {
      H.onSnapshot?.(req.market, obj.snapshot);
    }
    for (const u of obj.placed || [])   H.onOrderEvent?.({ type: 'ADDED', market: req.market, uuid: u });
    for (const u of obj.canceled || []) H.onOrderEvent?.({ type: 'CANCELED', market: req.market, uuid: u });
    for (const u of obj.amended || [])  H.onOrderEvent?.({ type: 'AMENDED', market: req.market, uuid: u });

    return obj;
  },
};
