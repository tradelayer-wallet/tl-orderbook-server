// lib.rs — matcher-core (drop-in)
// Features:
// - per-market reverse id maps (ext<->int)
// - by_socket ownership
// - STPF maker-bump (default) / neutralize-taker (runtime toggle)
// - submit/cancel/edit/snapshot/stats/get_open_orders_by_socket
// - UUID/ULID tolerant ids, integerized price

use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use hashbrown::HashMap as FastMap;
use std::sync::Mutex;

// ---------- logging ----------
use std::fs::OpenOptions;
use std::io::Write;
use chrono::Local;

const LOG_PATH: &str = "/mnt/c/Users/patri/Downloads/tl_ob.log";
fn log_line<S: AsRef<str>>(s: S) {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let _ = writeln!(f, "[{}] {}", now, s.as_ref());
    }
}

// ---------- engine ----------
use orderbook_rs::prelude::{
    BookManager, BookManagerStd, OrderBook, OrderId, Side, TimeInForce, current_time_millis, OrderType,
};
use uuid::Uuid;
use ulid::Ulid;

// ---------- API types ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct JsOrder {
    pub uuid: String,
    pub side: String,     // "BUY" | "SELL"
    pub price: f64,
    pub amount: f64,
    pub socket_id: Option<String>,
}

// ---------- global state ----------
#[derive(Default)]
struct State {
    man: BookManagerStd<()>,

    // symbol -> socket -> [ids] (ids may be engine-id string or external uuid)
    by_socket: HashMap<String, FastMap<String, Vec<String>>>,

    // symbol -> external uuid -> engine-id (string form)
    ext2int: HashMap<String, FastMap<String, String>>,
    // symbol -> engine-id (string form) -> external uuid
    int2ext: HashMap<String, FastMap<String, String>>,
}

impl State {
    fn ensure_maps(&mut self, symbol: &str) {
        self.by_socket.entry(symbol.to_string()).or_default();
        self.ext2int.entry(symbol.to_string()).or_default();
        self.int2ext.entry(symbol.to_string()).or_default();
    }
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));
use std::collections::{HashMap, VecDeque};

const HISTORY_CAP: usize = 500; // per socket per symbol

pub struct EngineState {
    // existing fields...
    pub history: HashMap<String, HashMap<String, VecDeque<serde_json::Value>>>, // symbol -> socket -> entries
}

impl EngineState {
    pub fn push_hist(&mut self, symbol: &str, socket: &str, entry: serde_json::Value) {
        let q = self.history
            .entry(symbol.to_string())
            .or_default()
            .entry(socket.to_string())
            .or_insert_with(|| VecDeque::with_capacity(HISTORY_CAP));
        if q.len() == HISTORY_CAP { q.pop_front(); }
        q.push_back(entry);
    }
}


// ---------- STPF policy ----------
#[derive(Clone, Copy)]
enum StpfPolicy { NeutralizeTaker, MakerBump }
static STPF_POLICY: Lazy<Mutex<StpfPolicy>> =
    Lazy::new(|| Mutex::new(StpfPolicy::MakerBump));

#[napi]
pub fn set_stpf_policy(policy: String) -> bool {
    let mut g = STPF_POLICY.lock().unwrap();
    *g = match policy.to_ascii_lowercase().as_str() {
        "neutralize" | "neutralize_taker" => StpfPolicy::NeutralizeTaker,
        _ => StpfPolicy::MakerBump,
    };
    true
}

// ---------- helpers ----------
const PRICE_SCALE: f64 = 1e2; // adjust if engine uses a different scale
#[inline] fn to_price_u64(px: f64) -> u64 { ((px * PRICE_SCALE).round()).max(0.0) as u64 }
#[inline] fn to_qty_u64(q: f64) -> u64 { (q.round()).max(0.0) as u64 }

#[inline]
fn parse_side(s: &str) -> Side {
    match s.to_ascii_lowercase().as_str() { "buy" | "b" => Side::Buy, _ => Side::Sell }
}

fn to_order_id(s: &str) -> OrderId {
    if let Ok(u) = Uuid::parse_str(s) { return OrderId::Uuid(u); }
    if s.len() == 26 {
        if let Ok(u) = s.parse::<Ulid>() { return OrderId::Ulid(u); }
    }
    // fall back to default; never crash on malformed
    OrderId::default()
}

// Find which socket owns a given *string* id for a symbol
fn socket_owner_of(s: &State, symbol: &str, id_str: &str) -> Option<String> {
    s.by_socket.get(symbol).and_then(|by_sock| {
        by_sock.iter().find_map(|(sock, ids)| {
            if ids.iter().any(|x| x == id_str) { Some(sock.clone()) } else { None }
        })
    })
}

// robust check against both Display and Debug engine id forms
fn sock_owns_engine_id(s: &State, symbol: &str, sock: &str, engine_id: &OrderId) -> bool {
    let a = engine_id.to_string();
    let b = format!("{:?}", engine_id);
    if let Some(ids) = s.by_socket.get(symbol).and_then(|m| m.get(sock)) {
        ids.iter().any(|x| x == &a || x == &b)
    } else { false }
}

// ---------- book lifecycle ----------
#[napi]
pub fn create_book(symbol: String) -> bool {
    let mut s = STATE.lock().unwrap();
    if !s.man.has_book(&symbol) { s.man.add_book(&symbol); }
    s.ensure_maps(&symbol);
    true
}

#[napi]
pub fn drop_book(symbol: String) -> bool {
    let mut s = STATE.lock().unwrap();
    s.by_socket.remove(&symbol);
    s.ext2int.remove(&symbol);
    s.int2ext.remove(&symbol);
    s.man.remove_book(&symbol).is_some()
}

// ---------- submit ----------
#[napi]
pub fn submit(symbol: String, order: JsOrder) -> napi::Result<String> {
    use std::collections::{HashMap, HashSet};

    let mut s = STATE.lock().unwrap();
    if !s.man.has_book(&symbol) {
        s.man.add_book(&symbol);
    }
    s.ensure_maps(&symbol);

    // --- normalize inputs ---
    let ext_id  = order.uuid.clone();
    let eng_id  = to_order_id(&ext_id);
    let eng_str = eng_id.to_string();
    let price   = to_price_u64(order.price);
    let qty     = to_qty_u64(order.amount);
    let side    = parse_side(&order.side);
    let sock_id = order.socket_id.clone(); // Option<String>
    let now     = current_time_millis();

    log_line(format!(
        "[SUBMIT] {symbol} {:?} px={} qty={} ext={} int={}",
        side, price, qty, ext_id, eng_str
    ));

    // History: SUBMIT_ACK (for taker)
    if let Some(sock) = order.socket_id.as_ref() {
        s.push_hist(&symbol, sock, serde_json::json!({
            "ts": now, "uuid": ext_id, "side": order.side, "price": order.price,
            "qty": order.amount, "event": "SUBMIT_ACK", "symbol": symbol
        }));
    }

    // ----------------------------------------------------------------
    // 1) Pre-snapshot FIFO for maker attribution (only opposite side)
    // ----------------------------------------------------------------
    let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };
    let mut pre_fifo: HashMap<u64, Vec<(String, u64)>> = HashMap::new();
    {
        let depth = 128usize;
        let book  = s.man.get_book_mut(&symbol).expect("book exists");
        let snap  = book.create_snapshot(depth);
        let levels = match maker_side { Side::Buy => &snap.bids, Side::Sell => &snap.asks };
        for lvl in levels {
            let mut fifo = Vec::<(String, u64)>::new();
            for ord in &lvl.orders {
                if let OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                    fifo.push((id.to_string(), *quantity as u64));
                }
            }
            if !fifo.is_empty() { pre_fifo.insert(lvl.price, fifo); }
        }
    }

    // ----------------------------------------------------------------
    // 2) STPF (self-trade prevention) against currently resting makers
    // ----------------------------------------------------------------
    match *STPF_POLICY.lock().unwrap() {
        StpfPolicy::NeutralizeTaker => {
            if let Some(ref taker_sock) = sock_id {
                let book = s.man.get_book_mut(&symbol).expect("book exists");
                let snap = book.create_snapshot(256);
                let levels = match side { Side::Buy => snap.asks, Side::Sell => snap.bids };
                let mut self_cross = false;
                'outer: for lvl in levels {
                    let crosses = match side { Side::Buy => lvl.price <= price, Side::Sell => lvl.price >= price };
                    if !crosses { break; }
                    for ord in lvl.orders {
                        if let OrderType::Standard { id, .. } = ord.as_ref() {
                            if sock_owns_engine_id(&s, &symbol, taker_sock, id) {
                                self_cross = true; break 'outer;
                            }
                        }
                    }
                }
                if self_cross {
                    log_line("[STPF] neutralize taker (self-cross); skipping place");
                    return Ok(r#"{"placed":false,"executed_qty":0,"remaining_qty":0,"is_complete":true,"transactions":[],"maker_slices":[]}"#.into());
                }
            }
        }
        StpfPolicy::MakerBump => {
            if let Some(ref taker_sock) = sock_id {
                let depth = 256usize;
                let book  = s.man.get_book_mut(&symbol).expect("book exists");
                let snap  = book.create_snapshot(depth);
                let levels = match side { Side::Buy => snap.asks, Side::Sell => snap.bids };
                let mut to_cancel = Vec::<OrderId>::new();
                for lvl in levels {
                    let crosses = match side { Side::Buy => lvl.price <= price, Side::Sell => lvl.price >= price };
                    if !crosses { break; }
                    for ord in lvl.orders {
                        if let OrderType::Standard { id, .. } = ord.as_ref() {
                            if sock_owns_engine_id(&s, &symbol, taker_sock, id) {
                                to_cancel.push(id.clone());
                            }
                        }
                    }
                }
                if !to_cancel.is_empty() {
                    let book = s.man.get_book_mut(&symbol).expect("book exists");
                    for oid in &to_cancel { let _ = book.cancel_order(oid.clone()); }
                    // Remove canceled makers from by_socket + int2ext
                    if let Some(m) = s.by_socket.get_mut(&symbol) {
                        if let Some(ids) = m.get_mut(taker_sock) {
                            ids.retain(|stored| !to_cancel.iter().any(|oid| {
                                let a = oid.to_string();
                                let b = format!("{:?}", oid);
                                stored == &a || stored == &b
                            }));
                        }
                    }
                    if let Some(int2ext) = s.int2ext.get_mut(&symbol) {
                        for oid in &to_cancel { int2ext.remove(&oid.to_string()); }
                    }
                    log_line(format!("[STPF] maker-bump: cancelled {} self makers", to_cancel.len()));
                }
            }
        }
    }

    // ----------------------------------------------------------------
    // 3) Record ownership (AFTER STPF passes), then match the taker slice
    // ----------------------------------------------------------------
    if let Some(ref sock) = sock_id {
        s.by_socket
            .entry(symbol.clone())
            .or_default()
            .entry(sock.clone())
            .or_default()
            .insert(eng_str.clone()); // store internal id only
    }

    let mr = {
        let book = s.man.get_book_mut(&symbol).expect("book exists");
        book
            .match_limit_order(eng_id.clone(), qty, side, price)
            .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?
    };

    // ----------------------------------------------------------------
    // 4) If remainder rests, add order and set ext<->int map
    // ----------------------------------------------------------------
    if !mr.is_complete && mr.remaining_quantity > 0 {
        let mut book = s.man.get_book_mut(&symbol).expect("book exists");
        let order_to_add = OrderType::Standard {
            id: eng_id.clone(),
            price,
            quantity: mr.remaining_quantity,
            side,
            timestamp: current_time_millis(),
            time_in_force: TimeInForce::Gtc,
            extra_fields: (),
        };
        if let Err(e) = book.add_order(order_to_add) {
            log_line(format!("[ERROR] add_order remainder: {:?}", e));
        } else {
            s.ext2int.entry(symbol.clone()).or_default().insert(ext_id.clone(), eng_str.clone());
            s.int2ext.entry(symbol.clone()).or_default().insert(eng_str.clone(), ext_id.clone());
        }
    } else {
        // Full fill: cleanup ownership so "open" list is accurate
        if let Some(ref sock) = sock_id {
            if let Some(per_sock) = s.by_socket.get_mut(&symbol) {
                if let Some(set) = per_sock.get_mut(sock) {
                    set.remove(&eng_str);
                    set.remove(&format!("{:?}", eng_id)); // if ever stored debug fmt
                    // set.remove(&ext_id); // only if you previously kept ext ids
                    if set.is_empty() { per_sock.remove(sock); }
                }
            }
        }
    }

    // ----------------------------------------------------------------
    // 5) Maker attribution from snapshot FIFO + taker/maker MATCH logs
    // ----------------------------------------------------------------
    let mut maker_slices: Vec<serde_json::Value> = Vec::new();
    let mut sum_qty = 0f64;
    let mut sum_notional = 0f64;

    for tx in mr.transactions.as_vec().iter() {
        let px = (tx.price as f64) / PRICE_SCALE;
        let q  = tx.quantity as f64;
        sum_qty += q;
        sum_notional += q * px;

        // taker history
        if let Some(sock) = order.socket_id.as_ref() {
            s.push_hist(&symbol, sock, serde_json::json!({
                "ts": now, "uuid": ext_id, "side": order.side,
                "price": px, "qty": q, "event": "MATCH", "role": "taker", "symbol": symbol
            }));
        }

        // maker-side attribution
        if let Some(fifo) = pre_fifo.get_mut(&tx.price) {
            let mut want = tx.quantity;
            let mut i = 0usize;
            while want > 0 && i < fifo.len() {
                let (maker_id, rem_val) = { let (id_s, q2) = &fifo[i]; (id_s.clone(), *q2) };
                let take = want.min(rem_val);
                if take > 0 {
                    // skip self
                    let is_self = sock_id
                        .as_ref()
                        .and_then(|sock| socket_owner_of(&s, &symbol, &maker_id).map(|o| o == *sock))
                        .unwrap_or(false);
                    if !is_self {
                        maker_slices.push(serde_json::json!({
                            "maker_order_id": maker_id,
                            "taker_order_id": format!("{:?}", eng_id),
                            "price": px,
                            "quantity": take as f64,
                            "maker": true
                        }));
                        // maker history (owner)
                        if let Some(maker_sock) = socket_owner_of(&s, &symbol, &maker_id) {
                            let ext = s.int2ext
                                .get(&symbol).and_then(|m| m.get(&maker_id)).cloned().unwrap_or_default();
                            s.push_hist(&symbol, &maker_sock, serde_json::json!({
                                "ts": now, "uuid": ext,
                                "side": match order.side.as_str() { "BUY" => "SELL", _ => "BUY" },
                                "price": px, "qty": take as f64,
                                "event": "MATCH", "role": "maker", "symbol": symbol
                            }));
                        }
                    }
                    fifo[i].1 -= take;
                    want -= take;
                    if fifo[i].1 == 0 { i += 1; } else { break; }
                } else { i += 1; }
            }
            fifo.drain(..i);
        }
    }

    // ----------------------------------------------------------------
    // 6) Build response payload (+ history summary)
    // ----------------------------------------------------------------
    let avg_px = if sum_qty > 0.0 { sum_notional / sum_qty } else { 0.0 };
    let exec = mr.executed_quantity() as f64;
    let rem  = mr.remaining_quantity as f64;
    let filled = mr.is_complete && exec > 0.0;

    if let Some(sock) = order.socket_id.as_ref() {
        if exec > 0.0 {
            s.push_hist(&symbol, sock, serde_json::json!({
                "ts": now,
                "uuid": ext_id,
                "side": order.side,
                "event": if filled { "FILLED" } else { "PARTIAL_FILL" },
                "executed_qty": exec,
                "remaining_qty": rem,
                "avg_price": avg_px,
                "symbol": symbol
            }));
        }
        if !mr.is_complete && mr.remaining_quantity > 0.0 {
            s.push_hist(&symbol, sock, serde_json::json!({
                "ts": now,
                "uuid": ext_id,
                "side": order.side,
                "event": "RESTED",
                "resting_qty": rem,
                "symbol": symbol
            }));
        }
    }

    let txns = mr.transactions.as_vec().iter().map(|tx| {
        serde_json::json!({
            "quantity": (tx.quantity as f64),
            "price": (tx.price as f64) / PRICE_SCALE,
            "transaction_id": tx.transaction_id,
            "maker": false
        })
    }).collect::<Vec<_>>();

    let payload = serde_json::json!({
        "order_id": format!("{:?}", mr.order_id),
        "executed_qty": (mr.executed_quantity() as f64),
        "remaining_qty": (mr.remaining_quantity as f64),
        "is_complete": mr.is_complete,
        "avg_price": avg_px,
        "transactions": txns,
        "maker_slices": maker_slices,
        "filled_order_ids": mr.filled_order_ids.iter().map(|fid| format!("{:?}", fid)).collect::<Vec<_>>()
    });

    Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}



// Fast path: reuse single submit() & cancel() to keep STPF + attribution logic identical.
// Returns JSON string: { canceled:[], placed:[], execs:[], snapshot: <optional> }
#[napi]
pub fn submit_batch(req: BatchReq) -> napi::Result<String> {
  let mut out_canceled: Vec<String> = Vec::new();
  let mut out_placed:  Vec<String> = Vec::new();
  let mut out_execs:   Vec<serde_json::Value> = Vec::new();

  // 1) cancels
  if let Some(list) = &req.cancel {
    for uuid in list {
      if cancel(req.market.clone(), uuid.clone()) {
        out_canceled.push(uuid.clone());
      }
    }
  }

  // 2) places
  if let Some(list) = &req.place {
    for o in list {
      // call your existing submit() so STPF & maker attribution stay consistent
      let raw = submit(
        req.market.clone(),
        JsOrder {
          uuid:      o.uuid.clone(),
          side:      o.side.clone(),
          price:     o.price,
          amount:    o.amount,
          socket_id: o.socket_id.clone(),
        }
      )?;

      // pull any maker_slices into execs for the sink
      if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(arr) = val.get("maker_slices").and_then(|x| x.as_array()) {
          for e in arr { out_execs.push(e.clone()); }
        }
      }

      out_placed.push(o.uuid.clone());
    }
  }

  // 3) optional snapshot
  let snapshot = if let Some(levels) = req.snap_levels {
    let s = STATE.lock().unwrap(); // short immutable borrow
    if let Some(book) = s.man.get_book(&req.market) {
      let snap = book.create_snapshot(levels as usize);
      Some(serde_json::to_value(snap).unwrap_or(serde_json::Value::Null))
    } else {
      None
    }
  } else { None };

  let payload = serde_json::json!({
    "canceled": out_canceled,
    "placed":   out_placed,
    "execs":    out_execs,
    "snapshot": snapshot
  });

  Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}


// ---------- cancel ----------//#[napi]
pub fn cancel(symbol: String, order_id: String) -> bool {
    use std::collections::HashSet;

    let mut s = STATE.lock().unwrap();
    s.ensure_maps(&symbol);

    // Resolve internal and external IDs
    // If the caller passed an external UUID, translate it.
    // If they passed an internal id string, use that as-is.
    let (eng_str, ext_id) = {
        if let Some(m) = s.ext2int.get(&symbol) {
            if let Some(int_id) = m.get(&order_id) {
                (int_id.clone(), order_id.clone())       // order_id was external
            } else {
                // Otherwise treat order_id as internal & try to find its ext
                let ext = s.int2ext
                    .get(&symbol)
                    .and_then(|m2| m2.get(&order_id))
                    .cloned()
                    .unwrap_or_else(|| order_id.clone());
                (order_id.clone(), ext)
            }
        } else {
            // ext2int not present for symbol; treat as internal and try reverse
            let ext = s.int2ext
                .get(&symbol)
                .and_then(|m2| m2.get(&order_id))
                .cloned()
                .unwrap_or_else(|| order_id.clone());
            (order_id.clone(), ext)
        }
    };

    let eng = to_order_id(&eng_str);

    // Cancel in the book
    let ok = {
        if let Some(book) = s.man.get_book_mut(&symbol) {
            book.cancel_order(eng.clone()).is_ok()
        } else {
            false
        }
    };
    if !ok {
        return false;
    }

    // Clean reverse maps
    if let Some(m) = s.int2ext.get_mut(&symbol) {
        let _ = m.remove(&eng_str);
    }
    if let Some(m) = s.ext2int.get_mut(&symbol) {
        let _ = m.remove(&ext_id);
    }

    // Remove internal id from by_socket (all sockets just in case)
    if let Some(per_sock) = s.by_socket.get_mut(&symbol) {
        for (_sock, ids) in per_sock.iter_mut() {
            ids.remove(&eng_str);
        }
        // Optional: prune empty socket entries
        per_sock.retain(|_, ids: &mut HashSet<String>| !ids.is_empty());
    }

    // Push history for the owner socket (if we can find it)
    if let Some(sock) = socket_owner_of(&s, &symbol, &eng_str) {
        s.push_hist(&symbol, &sock, serde_json::json!({
            "ts": current_time_millis(),
            "uuid": ext_id,
            "event": "CANCELLED",
            "symbol": symbol
        }));
    }

    true
}

// ---------- edit (cancel+readd with plan; maker-bump for price edits) ----------//
#[napi]
pub fn edit(
    symbol: String,
    order_id: String,     // can be external UUID or internal id string
    new_qty: Option<f64>,
    new_price: Option<f64>
) -> napi::Result<bool> {
    use std::collections::HashSet;
    use orderbook_rs::prelude::{Side, TimeInForce};

    let mut s = STATE.lock().unwrap();
    s.ensure_maps(&symbol);

    // Resolve internal id from the given order_id
    let eng_str = if let Some(m) = s.ext2int.get(&symbol) {
        m.get(&order_id).cloned().unwrap_or(order_id.clone())
    } else {
        order_id.clone()
    };
    let eng_id = to_order_id(&eng_str);

    // Owner socket (no book borrow)
    let owner_sock: Option<String> = socket_owner_of(&s, &symbol, &eng_str);

    // Snapshot to locate current side/px/qty
    let (snap_side, cur_px, cur_qty) = {
        let Some(book) = s.man.get_book_mut(&symbol) else { return Ok(false) };
        let snap = book.create_snapshot(512);

        let mut cs: Option<Side> = None;
        let mut px: Option<u64> = None;
        let mut q:  Option<u64> = None;

        'scan: {
            for lvl in &snap.bids {
                for ord in &lvl.orders {
                    if let orderbook_rs::OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                        if *id == eng_id { cs = Some(Side::Buy); px = Some(lvl.price); q = Some(*quantity); break 'scan; }
                    }
                }
            }
            for lvl in &snap.asks {
                for ord in &lvl.orders {
                    if let orderbook_rs::OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                        if *id == eng_id { cs = Some(Side::Sell); px = Some(lvl.price); q = Some(*quantity); break 'scan; }
                    }
                }
            }
        }
        let (Some(cs), Some(px), Some(q)) = (cs, px, q) else { return Ok(false) };
        (cs, px, q)
    };

    let tgt_qty = new_qty.map(to_qty_u64).unwrap_or(cur_qty);
    let tgt_px  = new_price.map(to_price_u64).unwrap_or(cur_px);

    // Plan STPF cancels for price edits
    let mut stpf_to_cancel: Vec<orderbook_rs::prelude::OrderId> = Vec::new();
    if new_price.is_some() {
        if let Some(ref taker_sock) = owner_sock {
            // need a snapshot; borrow ended above
            let opp_levels = {
                let Some(book) = s.man.get_book_mut(&symbol) else { return Ok(false) };
                let snap = book.create_snapshot(512);
                match snap_side { Side::Buy => snap.asks, Side::Sell => snap.bids }
            };
            for lvl in opp_levels.iter() {
                let crosses = match snap_side { Side::Buy => lvl.price <= tgt_px, Side::Sell => lvl.price >= tgt_px };
                if !crosses { break; }
                for ord in &lvl.orders {
                    if let orderbook_rs::OrderType::Standard { id, .. } = ord.as_ref() {
                        if sock_owns_engine_id(&s, &symbol, taker_sock, id) {
                            stpf_to_cancel.push(id.clone());
                        }
                    }
                }
            }
        }
    }

    // Cancel & re-add under a short borrow
    let ok = {
        let Some(book) = s.man.get_book_mut(&symbol) else { return Ok(false) };

        // STPF cancels (self makers that would cross new price)
        for oid in &stpf_to_cancel {
            let _ = book.cancel_order(oid.clone());
        }

        // Replace the edited order (cancel+readd with same id)
        let _ = book.cancel_order(eng_id.clone());
        let add = orderbook_rs::OrderType::Standard {
            id: eng_id.clone(),
            price: tgt_px,
            quantity: tgt_qty,
            side: snap_side,
            timestamp: current_time_millis(),
            time_in_force: TimeInForce::Gtc,
            extra_fields: (),
        };
        book.add_order(add).is_ok()
    };

    // Clean maps for STPF-canceled makers
    if !stpf_to_cancel.is_empty() {
        if let Some(int2ext) = s.int2ext.get_mut(&symbol) {
            for oid in &stpf_to_cancel {
                let _ = int2ext.remove(&oid.to_string());
            }
        }
        if let Some(per_sock) = s.by_socket.get_mut(&symbol) {
            for (_sock, ids) in per_sock.iter_mut() {
                for oid in &stpf_to_cancel {
                    ids.remove(&oid.to_string());
                }
            }
        }
    }

    // History: AMENDED record
    if ok {
        if let Some(sock) = owner_sock {
            s.push_hist(&symbol, &sock, serde_json::json!({
                "ts": current_time_millis(),
                "uuid": s.int2ext.get(&symbol).and_then(|m| m.get(&eng_str)).cloned().unwrap_or(order_id),
                "event": "AMENDED",
                "symbol": symbol,
                "old_price": (cur_px as f64) / PRICE_SCALE,
                "old_qty":   (cur_qty as f64),
                "new_price": (tgt_px as f64) / PRICE_SCALE,
                "new_qty":   (tgt_qty as f64)
            }));
        }
    }

    Ok(ok)
}

// Add near your other #[napi(object)] types
#[napi(object)]
pub struct BatchReq {
  pub market: String,
  pub cancel: Option<Vec<String>>,
  pub place:  Option<Vec<JsOrder>>,
  pub snap_levels: Option<u32>,
}

// Cancel everything owned by a given socket in a market.
// Returns number of orders successfully canceled.
#[napi]
pub fn cancel_all_by_socket(symbol: String, socket_id: String) -> u32 {
  let mut s = STATE.lock().unwrap();

  // 1) Detach the list of ids first (avoid holding two borrows at once)
  let ids: Vec<String> = s
    .by_socket
    .get_mut(&symbol)
    .and_then(|per_socket| per_socket.remove(&socket_id))
    .unwrap_or_default();

  // 2) Cancel on the book
  let mut n = 0u32;
  if let Some(book) = s.man.get_book_mut(&symbol) {
    for oid_str in ids {
      let oid = to_order_id(&oid_str);
      if book.cancel_order(oid).is_ok() { n += 1; }
    }
  }

  n
}


// ---------- snapshots / stats ----------
#[napi]
pub fn snapshot(symbol: String, depth: Option<u32>) -> String {
    let s = STATE.lock().unwrap();
    if let Some(book) = s.man.get_book(&symbol) {
        let d = depth.unwrap_or(20) as usize;
        match book.snapshot_to_json(d) { Ok(json) => json, Err(_) => "{}".into() }
    } else { "{}".into() }
}

#[napi]
pub fn stats(symbol: String) -> String {
    let s = STATE.lock().unwrap();
    if let Some(book) = s.man.get_book(&symbol) {
        let payload = serde_json::json!({
            "symbol": symbol,
            "best_bid": book.best_bid(),
            "best_ask": book.best_ask(),
            "spread":   book.spread(),
            "last_trade_price": book.last_trade_price(),
            "ts": current_time_millis()
        });
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into())
    } else { "{}".into() }
}

// ---------- FE tray helper ----------
#[napi]
pub fn get_open_orders_by_socket(socket_id: String, symbol: String) -> String {
    let s = STATE.lock().unwrap();
    let mut out: Vec<String> = Vec::new();

    if let (Some(per_sock), Some(int2ext)) = (s.by_socket.get(&symbol), s.int2ext.get(&symbol)) {
        if let Some(eng_ids) = per_sock.get(&socket_id) {
            for eng in eng_ids {
                if let Some(ext) = int2ext.get(eng) {
                    out.push(ext.clone()); // only currently resting orders
                }
            }
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

#[napi]
pub fn get_order_history_by_socket(socket_id: String, symbol: String, limit: Option<u32>) -> String {
    let s = STATE.lock().unwrap();
    let lim = limit.unwrap_or(200) as usize;
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(per_sock) = s.history.get(&symbol) {
        if let Some(q) = per_sock.get(&socket_id) {
            let n = q.len();
            let start = n.saturating_sub(lim);
            out.extend(q.iter().skip(start).cloned());
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}


