use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use hashbrown::HashMap as FastMap;
use std::fs::OpenOptions;
use std::io::Write;

const LOG_PATH: &str = "/mnt/c/Users/patri/Downloads/tl_ob.log";
use chrono::Local;

fn log_line<S: AsRef<str>>(s: S) {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let _ = writeln!(f, "[{}] {}", now, s.as_ref());
    }
}

use orderbook_rs::prelude::{
  BookManager, BookManagerStd, OrderBook, OrderId, Side, current_time_millis,OrderType,
};
use std::sync::Arc;
use uuid::Uuid;
use ulid::Ulid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct JsOrder {
  pub uuid: String,
  pub side: String,   // "BUY" | "SELL"
  pub price: f64,
  pub amount: f64,
  pub socket_id: Option<String>,
}

#[derive(Default)]
struct State {
  man: BookManagerStd<()>,
  // symbol -> socket -> [ids]; we store *both* engine id strings (Display/Debug) AND external uuids
  by_socket: HashMap<String, FastMap<String, Vec<String>>>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

// Scales allow sub-unit precision while staying integer-safe.
const PRICE_SCALE: f64 = 1e2; // integerize price
const QTY_SCALE: f64 = 1.0;   // identity, no scaling

fn to_price_u64(p: f64) -> u64 {
    if p.is_finite() && p > 0.0 {
        (p * PRICE_SCALE).round() as u64
    } else {
        0
    }
}

fn to_qty_u64(q: f64) -> u64 {
    if q.is_finite() && q > 0.0 {
        q.round() as u64   // pass plain integerized qty
    } else {
        0
    }
}

// Find which socket owns a given order id string, by scanning s.by_socket
fn socket_owner_of(s: &State, symbol: &str, order_id_str: &str) -> Option<String> {
    s.by_socket.get(symbol).and_then(|by_sock| {
        by_sock.iter().find_map(|(sock, ids)| {
            if ids.iter().any(|id| id == order_id_str) { Some(sock.clone()) } else { None }
        })
    })
}

// Robust ownership check against both Display and Debug forms of engine OrderId
fn sock_owns_engine_id(s: &State, symbol: &str, sock: &str, engine_id: &orderbook_rs::prelude::OrderId) -> bool {
    let a = engine_id.to_string();
    let b = format!("{:?}", engine_id);
    if let Some(ids) = s.by_socket.get(symbol).and_then(|m| m.get(sock)) {
        ids.iter().any(|x| x == &a || x == &b)
    } else {
        false
    }
}

#[inline]
fn parse_side(s: &str) -> Side {
    let side = match s.to_ascii_lowercase().as_str() {
        "buy" => Side::Buy,
        _ => Side::Sell,
    };
    log_line(format!("side parsed = {:?}", side));
    side
}

fn to_order_id(s: &str) -> OrderId {
  if let Ok(u) = Uuid::parse_str(s) {
    return OrderId::Uuid(u);
  }
  if s.len() == 26 {
    if let Ok(u) = s.parse::<Ulid>() {
      return OrderId::Ulid(u);
    }
  }
  // Fallback so we never crash on malformed ids (demo-friendly)
  OrderId::default()
}

#[napi]
pub fn create_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  if !s.man.has_book(&symbol) {
    s.man.add_book(&symbol);
  }
  s.by_socket.entry(symbol).or_default();
  true
}

// Thin alias so TS can call native.init_market(...)
#[napi]
pub fn init_market(symbol: String) -> bool {
  create_book(symbol)
}

#[napi]
pub fn drop_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.remove(&symbol);
  s.man.remove_book(&symbol).is_some()
}

#[napi]
pub fn submit(symbol: String, order: JsOrder) -> napi::Result<String> {
    use orderbook_rs::{OrderType, prelude::TimeInForce};
    use orderbook_rs::prelude::Side;

    let mut s = STATE.lock().unwrap();

    if !s.man.has_book(&symbol) {
        s.man.add_book(&symbol);
    }

    // Prepare params
    let id     = to_order_id(&order.uuid);
    let id_str = id.to_string();
    let price  = to_price_u64(order.price);
    let qty    = to_qty_u64(order.amount);
    let side   = parse_side(&order.side);

    log_line(format!("[SUBMIT] symbol={} side={:?} px={} qty={} id={}", symbol, side, price, qty, id_str));

    // ---------- PRE-SNAPSHOT: capture maker FIFO per price (for maker attribution only) ----------
    let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };
    let mut pre_fifo: std::collections::HashMap<u64, Vec<(String, u64)>> = std::collections::HashMap::new();
    {
        let depth = 64usize;
        let book  = s.man.get_book_mut(&symbol).expect("book exists");
        let snap  = book.create_snapshot(depth);
        let levels = match maker_side { Side::Buy => &snap.bids, Side::Sell => &snap.asks };
        for lvl in levels.iter() {
            let mut fifo: Vec<(String, u64)> = Vec::new();
            for ord in &lvl.orders {
                if let OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                    fifo.push((id.to_string(), *quantity as u64));
                }
            }
            if !fifo.is_empty() { pre_fifo.insert(lvl.price, fifo); }
        }
    } // drop book borrow

    // === STPF: maker-bump (cancel self-owned crossing MAKER orders) ===
    if let Some(ref taker_sock) = order.socket_id {
        let mut to_cancel = Vec::<orderbook_rs::prelude::OrderId>::new();
        {
            let depth = 256usize;
            let book  = s.man.get_book_mut(&symbol).expect("book exists");
            let snap  = book.create_snapshot(depth);
            let levels = match side { Side::Buy => snap.asks, Side::Sell => snap.bids };

            for lvl in levels.iter() {
                let crosses = match side {
                    Side::Buy  => lvl.price <= price,
                    Side::Sell => lvl.price >= price,
                };
                if !crosses { break; }

                for ord in &lvl.orders {
                    if let orderbook_rs::OrderType::Standard { id, .. } = ord.as_ref() {
                        if sock_owns_engine_id(&s, &symbol, taker_sock, id) {
                            to_cancel.push(id.clone());
                        }
                    }
                }
            }
        }

        if !to_cancel.is_empty() {
            let book = s.man.get_book_mut(&symbol).expect("book exists");
            for oid in to_cancel.iter() {
                let _ = book.cancel_order(oid.clone());
            }
            // prune both Display and Debug forms from by_socket for this taker socket
            if let Some(ids) = s.by_socket.get_mut(&symbol).and_then(|m| m.get_mut(taker_sock)) {
                ids.retain(|stored| {
                    !to_cancel.iter().any(|oid| {
                        let a = oid.to_string();
                        let b = format!("{:?}", oid);
                        stored == &a || stored == &b
                    })
                });
            }
            log_line(format!("[STPF] maker-bump: cancelled {} self maker orders", to_cancel.len()));
        }
    }
    // === end STPF ===

    // Track owner by socket (AFTER STPF passes)
    if let Some(sock) = &order.socket_id {
        let v = s.by_socket
            .entry(symbol.clone())
            .or_default()
            .entry(sock.clone())
            .or_default();
        if !v.iter().any(|x| x == &id_str)     { v.push(id_str.clone()); }
        if !v.iter().any(|x| x == &order.uuid) { v.push(order.uuid.clone()); }
        log_line(format!("[OWNERMAP] sock={} symbol={} ids=[{}, {}]", sock, symbol, id_str, order.uuid));
    }

    // --- Match
    let mr = {
        let book = s.man.get_book_mut(&symbol).expect("book exists");
        book
            .match_limit_order(id.clone(), qty, side, price)
            .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?
    };

    // --- Rest remainder (taker)
    if !mr.is_complete && mr.remaining_quantity > 0 {
        let mut book = s.man.get_book_mut(&symbol).expect("book exists");
        let order_to_add = OrderType::Standard {
            id: id.clone(),
            price,
            quantity: mr.remaining_quantity,
            side,
            timestamp: current_time_millis(),
            time_in_force: TimeInForce::Gtc,
            extra_fields: (),
        };
        if let Err(e) = book.add_order(order_to_add) {
            log_line(format!("[ERROR] add_order remainder: {:?}", e));
        }
    }

    // --- Maker attribution (no extra metadata; same as your original)
    let mut maker_slices: Vec<serde_json::Value> = Vec::new();
    let taker_sock_opt = order.socket_id.clone();

    for tx in mr.transactions.as_vec().iter() {
        let p = tx.price;
        let mut want = tx.quantity;

        if let Some(fifo) = pre_fifo.get_mut(&p) {
            let mut i = 0usize;
            while want > 0 && i < fifo.len() {
                // clone head to avoid aliasing
                let (maker_id, rem_val) = {
                    let (id_str, qty_ref) = &fifo[i];
                    (id_str.clone(), *qty_ref)
                };

                let take = want.min(rem_val);
                if take > 0 {
                    // if maker-bump worked, this should not be self; keep guard anyway
                    let is_self = if let Some(ref taker_sock) = taker_sock_opt {
                        socket_owner_of(&s, &symbol, &maker_id).as_ref() == Some(taker_sock)
                    } else { false };

                    if !is_self {
                        maker_slices.push(serde_json::json!({
                            "maker_order_id": maker_id,
                            "taker_order_id": format!("{:?}", id),
                            "price": (p as f64) / 1e2,
                            "quantity": take as f64,
                            "maker": true
                        }));
                    }

                    // advance FIFO
                    fifo[i].1 -= take;
                    want -= take;
                    if fifo[i].1 == 0 { i += 1; } else { break; }
                } else {
                    i += 1;
                }
            }
            fifo.drain(..i);
        }
    }

    // --- Taker-view transactions
    let txns = mr.transactions.as_vec().iter().map(|tx| {
        serde_json::json!({
            "quantity": (tx.quantity as f64),
            "price": (tx.price as f64) / 1e2,
            "transaction_id": tx.transaction_id,
            "maker": false
        })
    }).collect::<Vec<_>>();

    let payload = serde_json::json!({
        "order_id": format!("{:?}", mr.order_id),
        "executed_qty": (mr.executed_quantity() as f64),
        "remaining_qty": (mr.remaining_quantity as f64),
        "is_complete": mr.is_complete,
        "transactions": txns,
        "maker_slices": maker_slices,
        "filled_order_ids": mr.filled_order_ids.iter().map(|fid| format!("{:?}", fid)).collect::<Vec<_>>()
    });

    Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}

#[napi(object)]
pub struct BatchReq {
  pub market: String,
  pub cancel: Option<Vec<String>>,
  pub place:  Option<Vec<JsOrder>>,
  pub snap_levels: Option<u32>,
}

#[napi]
pub fn submit_batch(req: BatchReq) -> napi::Result<String> {
    let mut out_canceled: Vec<String> = Vec::new();
    let mut out_placed:  Vec<String> = Vec::new();
    let mut out_execs:   Vec<serde_json::Value> = Vec::new();

    // 1) cancels (reuse your single-cancel)
    if let Some(c) = &req.cancel {
        for uuid in c {
            if cancel(req.market.clone(), uuid.clone()) {
                out_canceled.push(uuid.clone());
            }
        }
    }

    // 2) places (reuse your single-submit to keep STPF + attribution)
    if let Some(p) = &req.place {
        for o in p {
            let s = submit(
                req.market.clone(),
                JsOrder {
                    uuid: o.uuid.clone(),
                    price: o.price,
                    amount: o.amount,
                    side: o.side.clone(),
                    socket_id: o.socket_id.clone(),
                    // forward any extra fields if you extend JsOrder later
                },
            )?;
            let parsed: serde_json::Value = serde_json::from_str(&s).unwrap_or(serde_json::json!({}));
            if let Some(ms) = parsed.get("maker_slices").and_then(|x| x.as_array()) {
                for e in ms { out_execs.push(e.clone()); }
            }
            out_placed.push(o.uuid.clone());
        }
    }

    // 3) optional snapshot
    let snapshot = if let Some(depth) = req.snap_levels {
        let mut s = STATE.lock().unwrap();
        if let Some(book) = s.man.get_book_mut(&req.market) {
            let snap = book.create_snapshot(depth as usize);
            Some(serde_json::to_value(snap).unwrap_or(serde_json::Value::Null))
        } else { None }
    } else { None };

    let payload = serde_json::json!({
        "canceled": out_canceled,
        "placed": out_placed,
        "execs": out_execs,
        "snapshot": snapshot
    });

    Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}

#[napi]
pub fn cancel(symbol: String, order_id: String) -> bool {
  let mut s = STATE.lock().unwrap();
  if let Some(book) = s.man.get_book_mut(&symbol) {
    let oid = to_order_id(&order_id);
    return book.cancel_order(oid).is_ok();
  }
  false
}

#[napi]
pub fn cancel_all_by_socket(symbol: String, socket_id: String) -> u32 {
  let mut s = STATE.lock().unwrap();
  let mut count = 0;
  if let Some(book_map) = s.by_socket.get_mut(&symbol) {
    if let Some(ids) = book_map.remove(&socket_id) {
      if let Some(book) = s.man.get_book_mut(&symbol) {
        for oid_str in ids {
          let oid = to_order_id(&oid_str);
          if book.cancel_order(oid).is_ok() {
            count += 1;
          }
        }
      }
    }
  }
  count
}

#[napi]
pub fn edit(symbol: String, order_id: String, new_qty: Option<f64>, new_price: Option<f64>) -> napi::Result<bool> {
    use orderbook_rs::prelude::{Side, OrderId as EngOrderId};
    use orderbook_rs::{OrderType, prelude::TimeInForce};

    // Resolve engine id and its string forms
    let eng_id: EngOrderId = to_order_id(&order_id);
    let eng_id_str = eng_id.to_string();
    let eng_id_dbg = format!("{:?}", eng_id);

    // Lock state
    let mut s = STATE.lock().unwrap();

    // --- (A) Resolve owner socket from by_socket (no book borrow yet) ---
    let taker_sock: Option<String> = s
        .by_socket
        .get(&symbol)
        .and_then(|per_sock| {
            for (sock, ids) in per_sock {
                if ids.iter().any(|x| x == &eng_id_str || x == &eng_id_dbg) {
                    return Some(sock.clone());
                }
            }
            None
        });

    // --- (B) Take a short book borrow to build a snapshot and locate the edited order ---
    let (snap, cur_side, cur_px, cur_qty) = {
        let Some(book) = s.man.get_book_mut(&symbol) else { return Ok(false) };
        let depth = 512usize;
        let snap = book.create_snapshot(depth);

        let mut cur_side: Option<Side> = None;
        let mut cur_px:   Option<u64>  = None;
        let mut cur_qty:  Option<u64>  = None;

        'scan: {
            for lvl in &snap.bids {
                for ord in &lvl.orders {
                    if let OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                        if *id == eng_id {
                            cur_side = Some(Side::Buy);
                            cur_px   = Some(lvl.price);
                            cur_qty  = Some(*quantity);
                            break 'scan;
                        }
                    }
                }
            }
            for lvl in &snap.asks {
                for ord in &lvl.orders {
                    if let OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                        if *id == eng_id {
                            cur_side = Some(Side::Sell);
                            cur_px   = Some(lvl.price);
                            cur_qty  = Some(*quantity);
                            break 'scan;
                        }
                    }
                }
            }
        }

        let (Some(cs), Some(px), Some(q)) = (cur_side, cur_px, cur_qty) else {
            return Ok(false); // order not found
        };

        (snap, cs, px, q)
    }; // <- book borrow ends here

    // Edited targets (default to current if None)
    let tgt_qty = new_qty.map(to_qty_u64).unwrap_or(cur_qty);
    let tgt_px  = new_price.map(to_price_u64).unwrap_or(cur_px);

    // --- (C) Plan STPF maker-bump using the snapshot (no book borrow needed here) ---
    let mut stpf_to_cancel: Vec<orderbook_rs::prelude::OrderId> = Vec::new();
    if new_price.is_some() {
        if let Some(ref taker_sock) = taker_sock {
            let opp_levels = match cur_side { Side::Buy => &snap.asks, Side::Sell => &snap.bids };
            for lvl in opp_levels.iter() {
                let crosses = match cur_side {
                    Side::Buy  => lvl.price <= tgt_px,
                    Side::Sell => lvl.price >= tgt_px,
                };
                if !crosses { break; }
                for ord in &lvl.orders {
                    if let OrderType::Standard { id, .. } = ord.as_ref() {
                        if sock_owns_engine_id(&s, &symbol, taker_sock, id) {
                            stpf_to_cancel.push(id.clone());
                        }
                    }
                }
            }
        }
    }

    // --- (D) Apply changes under a fresh short book borrow ---
    {
        let Some(book) = s.man.get_book_mut(&symbol) else { return Ok(false) };

        // STPF maker-bump: cancel self-owned makers that would cross the edited price
        if !stpf_to_cancel.is_empty() {
            for oid in stpf_to_cancel.drain(..) {
                let _ = book.cancel_order(oid);
            }
            log_line(format!("[STPF/edit] maker-bump canceled self makers before edit: {}", order_id));
        }

        // Cancel the edited order then re-add with same id and target fields
        let _ = book.cancel_order(eng_id.clone());

        let add = OrderType::Standard {
            id: eng_id.clone(),
            price: tgt_px,
            quantity: tgt_qty,
            side: cur_side,
            timestamp: current_time_millis(),
            time_in_force: TimeInForce::Gtc,
            extra_fields: (),
        };

        let ok = book.add_order(add).is_ok();
        return Ok(ok);
    }
}

#[napi]
pub fn snapshot(symbol: String, depth: Option<u32>) -> String {
  let s = STATE.lock().unwrap();
  if let Some(book) = s.man.get_book(&symbol) {
    log_line(format!("snapshot(): book {:p} symbol={}", book, symbol));
    let d = depth.unwrap_or(20) as usize;
    match book.snapshot_to_json(d) {
      Ok(json) => json,
      Err(_) => "{}".into(),
    }
  } else {
    "{}".into()
  }
}

#[napi]
pub fn stats(symbol: String) -> String {
  let s = STATE.lock().unwrap();
  if let Some(book) = s.man.get_book(&symbol) {
    let best_bid = book.best_bid();
    let best_ask = book.best_ask();
    let spread = book.spread();
    let last = book.last_trade_price();

    let payload = serde_json::json!({
      "symbol": symbol,
      "best_bid": best_bid,
      "best_ask": best_ask,
      "spread": spread,
      "last_trade_price": last,
      "ts": current_time_millis()
    });
    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into())
  } else {
    "{}".into()
  }
}

/* ===== Added: open orders tray ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct JsOpenOrder {
    pub uuid: String,
    pub market: String,
    pub side: String,
    pub price: f64,
    pub amount: f64,
}

/// Enumerate open orders belonging to a socket. If `market` is Some, restrict to that market.
#[napi]
pub fn get_open_orders_by_socket(socket_id: String, market: Option<String>) -> napi::Result<String> {
    use orderbook_rs::prelude::Side;

    let mut s = STATE.lock().unwrap();
    let mut out: Vec<JsOpenOrder> = Vec::new();

    // pick markets to scan
    let symbols: Vec<String> = if let Some(m) = &market {
        vec![m.clone()]
    } else {
        s.by_socket.keys().cloned().collect()
    };

    for symbol in symbols {
        // list of ids (engine id Display/Debug and possibly external uuid)
        let maybe_ids = s
            .by_socket
            .get(&symbol)
            .and_then(|by_sock| by_sock.get(&socket_id))
            .cloned();

        if maybe_ids.is_none() { continue; }
        let ids_vec = maybe_ids.unwrap();

        // Need snapshot to get px/qty/side; use a reasonable depth
        let Some(book) = s.man.get_book_mut(&symbol) else { continue; };
        let snap = book.create_snapshot(512);

        let mut push_found = |side: Side, px_u64: u64, qty_u64: u64, id: &orderbook_rs::prelude::OrderId| {
            // Prefer an external uuid from ids_vec if present; else fallback to engine string
            let id_str = id.to_string();
            let id_dbg = format!("{:?}", id);
            let ext_uuid = ids_vec.iter()
                .find(|x| **x != id_str && **x != id_dbg)
                .cloned()
                .unwrap_or(id_str.clone());
            out.push(JsOpenOrder {
                uuid: ext_uuid,
                market: symbol.clone(),
                side: match side { Side::Buy => "BUY".into(), Side::Sell => "SELL".into() },
                price: (px_u64 as f64) / 1e2, // keep in sync with PRICE_SCALE
                amount: qty_u64 as f64,
            });
        };

        for lvl in &snap.bids {
            for ord in &lvl.orders {
                if let orderbook_rs::OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                    let id_str = id.to_string();
                    let id_dbg = format!("{:?}", id);
                    if ids_vec.iter().any(|x| x == &id_str || x == &id_dbg) {
                        push_found(Side::Buy, lvl.price, *quantity as u64, id);
                    }
                }
            }
        }
        for lvl in &snap.asks {
            for ord in &lvl.orders {
                if let orderbook_rs::OrderType::Standard { id, quantity, .. } = ord.as_ref() {
                    let id_str = id.to_string();
                    let id_dbg = format!("{:?}", id);
                    if ids_vec.iter().any(|x| x == &id_str || x == &id_dbg) {
                        push_found(Side::Sell, lvl.price, *quantity as u64, id);
                    }
                }
            }
        }
    }

    Ok(serde_json::to_string(&out).unwrap_or_else(|_| "[]".into()))
}