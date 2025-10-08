// src/native.ts
/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('node:path');

function loadNative() {
  // try the actual path first
  const candidates = [
    path.join(__dirname, '..', 'rust', 'matcher-core', 'matcher_core.node')
  ];
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  throw new Error('Cannot load native addon. Tried rust/matcher-core and build/Release.');
}

const nat = loadNative();

export type JsOrder = {
  uuid: string; price: number; amount: number; side: 'BUY'|'SELL';
  socket_id?: string; type?: 'SPOT'|'FUTURES'; action?: 'BUY'|'SELL'; props?: any; keypair?: any;
};

export type Exec = {
  price: number; quantity: number;
  maker_socket_id?: string; taker_socket_id?: string;
  maker_ext_uuid?: string; taker_ext_uuid?: string;
};

type Handlers = {
  onExecs?: (market: string, execs: Exec[]) => void | Promise<void>;
  onSnapshot?: (market: string, snapshot: any) => void | Promise<void>;
  onOrderEvent?: (ev: { type: 'ADDED'|'CANCELED'|'AMENDED'; market: string; uuid: string; socket_id?: string; price?: number; quantity?: number }) => void | Promise<void>;
};
let H: Handlers = {};
export const registerNativeSinks = (h: Handlers) => { H = h || {}; };

export const native = {
  init_market: (s: string) => nat.init_market(s),
  snapshot: (s: string, levels?: number) => nat.snapshot(s, levels),

  submit: (market: string, order: JsOrder) => {
    const raw = nat.submit(market, order) as string;
    let obj: any = {}; try { obj = JSON.parse(raw); } catch {}
    // map your lib.rs maker_slices -> Exec[] if present
    const execs: Exec[] = (obj.maker_slices || []).map((m: any) => ({
      price: Number(m.price), quantity: Number(m.quantity),
      maker_socket_id: m.maker_socket_id, taker_socket_id: m.taker_socket_id,
      maker_ext_uuid: m.maker_ext_uuid, taker_ext_uuid: m.taker_ext_uuid,
    }));
    if (execs.length) H.onExecs?.(market, execs);

    // treat partially resting taker as ADDED
    const remained = Number(obj.remaining_qty || 0) > 0 && obj.is_complete === false;
    if (remained) H.onOrderEvent?.({ type: 'ADDED', market, uuid: order.uuid, socket_id: order.socket_id, price: order.price, quantity: Number(obj.remaining_qty) || order.amount });

    return obj; // keep your original return shape
  },

  cancel: (market: string, uuid: string) => {
    const ok = nat.cancel(market, uuid) as boolean;
    if (ok) H.onOrderEvent?.({ type: 'CANCELED', market, uuid });
    return ok;
  },

  edit: (market: string, uuid: string, newQty?: number, newPrice?: number) => {
    const ok = nat.edit(market, uuid, newQty, newPrice) as boolean;
    if (ok) H.onOrderEvent?.({ type: 'AMENDED', market, uuid, quantity: newQty, price: newPrice });
    return ok;
  },

  // optional, if you also expose batching natively
  submit_batch: (req: { market: string; cancel?: string[]; amend?: { uuid: string; new_quantity: number; new_price?: number }[]; place?: JsOrder[]; snap_levels?: number }) => {
    const res = nat.submit_batch(req) as { execs?: Exec[]; snapshot?: any; placed?: string[]; canceled?: string[]; amended?: string[] };
    if (res.execs?.length) H.onExecs?.(req.market, res.execs);
    if (res.snapshot) H.onSnapshot?.(req.market, res.snapshot);
    for (const u of res.placed || [])   H.onOrderEvent?.({ type: 'ADDED', market: req.market, uuid: u });
    for (const u of res.canceled || []) H.onOrderEvent?.({ type: 'CANCELED', market: req.market, uuid: u });
    for (const u of res.amended || [])  H.onOrderEvent?.({ type: 'AMENDED', market: req.market, uuid: u });
    return res;
  },
};
