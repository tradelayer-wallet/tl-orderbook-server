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
  BookManager, BookManagerStd, OrderBook, OrderId, Side, current_time_millis,
  OrderType,
};
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
  by_socket: HashMap<String, FastMap<String, Vec<String>>>, // symbol -> socket -> [orderIds]
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

#[napi]
pub fn drop_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.remove(&symbol);
  s.man.remove_book(&symbol).is_some()
}

#[napi]
pub fn submit(symbol: String, order: JsOrder) -> napi::Result<String> {
    use orderbook_rs::{OrderType, prelude::TimeInForce};
    use std::collections::HashMap;

    let mut s = STATE.lock().unwrap();

    // Ensure book exists
    if !s.man.has_book(&symbol) {
        s.man.add_book(&symbol);
    }

    // Prepare params (no book borrow needed)
    let id     = to_order_id(&order.uuid);
    let id_str = id.to_string();                 // engine-format id for owner lookup
    let price  = to_price_u64(order.price);
    let qty    = to_qty_u64(order.amount);
    let side   = parse_side(&order.side);

    // Track owner by socket (do this BEFORE any book mutable borrow)
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

    log_line(format!("[SUBMIT] symbol={} side={:?} px={} qty={} id={}", symbol, side, price, qty, id_str));
    log_line(format!("submit(): symbol={} side={:?} price={} qty={}", symbol, side, price, qty));

    // ---------- PRE-SNAPSHOT: capture maker FIFO per price ----------
    let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };
    let mut pre_fifo: HashMap<u64, Vec<(String, u64)>> = HashMap::new();
    {
        // (Scoped) borrow book for snapshot only
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
    } // book borrow dropped here

    // === STPF: cancel self maker orders that cross ===
    if let Some(ref taker_sock) = order.socket_id {
        let mut to_cancel = Vec::<orderbook_rs::prelude::OrderId>::new();
        {
            let depth = 256usize;
            let book = s.man.get_book_mut(&symbol).expect("book exists");
            let snap = book.create_snapshot(depth);
            let levels = match side { Side::Buy => snap.asks, Side::Sell => snap.bids };

            if let Some(owner_ids) = s.by_socket.get(&symbol).and_then(|m| m.get(taker_sock)) {
                for lvl in levels.iter() {
                    let crosses = match side {
                        Side::Buy => lvl.price <= price,
                        Side::Sell => lvl.price >= price,
                    };
                    if !crosses { break; }

                    for ord in &lvl.orders {
                        if let orderbook_rs::OrderType::Standard { id, .. } = ord.as_ref() {
                            let id_s = id.to_string();
                            if owner_ids.iter().any(|x| x == &id_s) {
                                to_cancel.push(id.clone());
                            }
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
            if let Some(ids) = s.by_socket.get_mut(&symbol).and_then(|m| m.get_mut(taker_sock)) {
                ids.retain(|x| !to_cancel.iter().any(|oid| *x == oid.to_string()));
            }
            log_line(format!("[STPF] pre-cancelled {} self maker orders", to_cancel.len()));
        }
    }
    // === end STPF ===

    // --- Match (scoped borrow)
    let mr = {
        let book = s.man.get_book_mut(&symbol).expect("book exists");
        book
            .match_limit_order(id.clone(), qty, side, price)
            .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?
    }; // book borrow dropped

    // If not fully matched, rest the remaining (taker) qty (scoped borrow)
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
            log_line(format!("add_order (taker remainder) error: {:?}", e));
            log_line(format!("[ERROR] add_order remainder: {:?}", e));
        }
        // book borrow dropped here
    }

    // ---------- Allocate fills + detect self for bump (no book borrow needed) ----------
    let mut self_refill_at_price: HashMap<u64, u64> = HashMap::new();
    let taker_sock_opt = order.socket_id.clone();

    let mut maker_slices: Vec<serde_json::Value> = Vec::new();
    for tx in mr.transactions.as_vec().iter() {
        let p = tx.price;
        let mut want = tx.quantity;

        if let Some(fifo) = pre_fifo.get_mut(&p) {
            let mut i = 0usize;
            while want > 0 && i < fifo.len() {
                // clone head to avoid aliased borrows
                let (maker_id, rem_val) = {
                    let (id_str, qty_ref) = &fifo[i];
                    (id_str.clone(), *qty_ref)
                };

                let take = want.min(rem_val);
                if take > 0 {
                    let is_self = if let Some(ref taker_sock) = taker_sock_opt {
                        socket_owner_of(&s, &symbol, &maker_id).as_ref() == Some(taker_sock)
                    } else { false };

                    if is_self {
                        *self_refill_at_price.entry(p).or_insert(0) += take;
                        log_line(format!("[SELF-MATCH] symbol={} price={} qty={} maker_id={} taker_id={}",
                            symbol, p, take, maker_id, id_str));
                    } else {
                        maker_slices.push(serde_json::json!({
                            "maker_order_id": maker_id,
                            "taker_order_id": format!("{:?}", id),
                            "price": (p as f64) / 1e2,
                            "quantity": take as f64,
                            "maker": true
                        }));
                    }

                    // mutate fifo after clone
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

    if !self_refill_at_price.is_empty() {
        let total: u64 = self_refill_at_price.values().copied().sum();
        log_line(format!("[SELF-BUMP] symbol={} side={:?} total_qty={} prices={:?}",
            symbol, side, total, self_refill_at_price.keys().cloned().collect::<Vec<_>>()));
    }

    // ---------- Re-add (bump) self-matched quantities on maker side ----------
    if !self_refill_at_price.is_empty() {
        let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };

        for (price_u64, qty_u64) in self_refill_at_price.into_iter() {
            if qty_u64 == 0 { continue; }

            // (scoped) book borrow just for add_order
            let bump_id = to_order_id(&format!("SELFREFILL-{}-{}", price_u64, current_time_millis()));
            {
                let mut book = s.man.get_book_mut(&symbol).expect("book exists");
                let order_to_add = OrderType::Standard {
                    id: bump_id.clone(),
                    price: price_u64,
                    quantity: qty_u64,
                    side: maker_side,
                    timestamp: current_time_millis(),
                    time_in_force: TimeInForce::Gtc,
                    extra_fields: (),
                };
                match book.add_order(order_to_add) {
                    Err(e) => {
                        log_line(format!("self-refill add_order error at price {}: {:?}", price_u64, e));
                        log_line(format!("[ERROR] self-refill add_order px={} err={:?}", price_u64, e));
                    }
                    Ok(_) => {
                        log_line(format!("[SELF-BUMP] readded px={} qty={} as {:?}", price_u64, qty_u64, bump_id));
                    }
                }
            } // drop book borrow

            // update by_socket for the new bump id (separate from book borrow)
            if let Some(ref taker_sock) = taker_sock_opt {
                s.by_socket
                    .entry(symbol.clone())
                    .or_default()
                    .entry(taker_sock.clone())
                    .or_default()
                    .push(format!("{:?}", bump_id));
            }
        }
    }

    // --- Serialize taker-view transactions (maker=false) ---
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

#[napi]
pub fn submit_batch(symbol: String, orders: Vec<JsOrder>) -> napi::Result<String> {
    use orderbook_rs::{OrderType, prelude::TimeInForce};
    use std::collections::HashMap;

    let mut s = STATE.lock().unwrap();

    if !s.man.has_book(&symbol) {
        s.man.add_book(&symbol);
    }

    let mut out = Vec::<serde_json::Value>::new();

    for o in orders {
        // Prepare first so we can store engine id in owner map
        let id     = to_order_id(&o.uuid);
        let id_str = id.to_string();
        let price  = to_price_u64(o.price);
        let qty    = to_qty_u64(o.amount);
        let side   = parse_side(&o.side);

        // Store both engine id and client uuid under socket
        if let Some(sock) = &o.socket_id {
            let v = s.by_socket
                .entry(symbol.clone())
                .or_default()
                .entry(sock.clone())
                .or_default();
            if !v.iter().any(|x| x == &id_str) { v.push(id_str.clone()); }
            if !v.iter().any(|x| x == &o.uuid) { v.push(o.uuid.clone()); }
            log_line(format!("[OWNERMAP] sock={} symbol={} ids=[{}, {}]", sock, symbol, id_str, o.uuid));
        }

        // --- PRE-SNAPSHOT maker FIFO (scoped borrow)
        let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };
        let mut pre_fifo: HashMap<u64, Vec<(String, u64)>> = HashMap::new();
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
        } // drop book

        // --- Match (scoped borrow)
        let mr = {
            let book = s.man.get_book_mut(&symbol).expect("book exists");
            book
                .match_limit_order(id.clone(), qty, side, price)
                .map_err(|e| Error::from_reason(format!("submit_batch: {e:?}")))?
        }; // drop book

        // Rest remainder (taker) (scoped)
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
                log_line(format!("add_order (taker remainder) error: {:?}", e));
                log_line(format!("[ERROR] add_order remainder: {:?}", e));
            }
        } // drop book

        // --- Maker attribution + self bump collection (no book borrow)
        let mut maker_slices: Vec<serde_json::Value> = Vec::new();
        let mut self_refill_at_price: HashMap<u64, u64> = HashMap::new();
        let taker_sock_opt = o.socket_id.clone();

        for tx in mr.transactions.as_vec().iter() {
            let p = tx.price;
            let mut want = tx.quantity;

            if let Some(fifo) = pre_fifo.get_mut(&p) {
                let mut i = 0usize;
                while want > 0 && i < fifo.len() {
                    let (maker_id, rem_val) = {
                        let (id_str, qty_ref) = &fifo[i];
                        (id_str.clone(), *qty_ref)
                    };
                    let take = want.min(rem_val);
                    if take > 0 {
                        let is_self = if let Some(ref taker_sock) = taker_sock_opt {
                            socket_owner_of(&s, &symbol, &maker_id).as_ref() == Some(taker_sock)
                        } else { false };

                        if is_self {
                            *self_refill_at_price.entry(p).or_insert(0) += take;
                            log_line(format!("[SELF-MATCH] symbol={} price={} qty={} maker_id={} taker_id={}",
                                symbol, p, take, maker_id, id_str));
                        } else {
                            maker_slices.push(serde_json::json!({
                                "maker_order_id": maker_id,
                                "taker_order_id": format!("{:?}", id),
                                "price": (p as f64) / 1e2,
                                "quantity": take as f64,
                                "maker": true
                            }));
                        }

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

        if !self_refill_at_price.is_empty() {
            let total: u64 = self_refill_at_price.values().copied().sum();
            log_line(format!("[SELF-BUMP] symbol={} side={:?} total_qty={} prices={:?}",
                symbol, side, total, self_refill_at_price.keys().cloned().collect::<Vec<_>>()));
        }

        // --- Re-add (bump) on maker side; update by_socket after each add
        if !self_refill_at_price.is_empty() {
            let maker_side = match side { Side::Buy => Side::Sell, Side::Sell => Side::Buy };

            for (price_u64, qty_u64) in self_refill_at_price.into_iter() {
                if qty_u64 == 0 { continue; }
                let bump_id = to_order_id(&format!("SELFREFILL-{}-{}", price_u64, current_time_millis()));

                {
                    // scoped book borrow for add_order
                    let mut book = s.man.get_book_mut(&symbol).expect("book exists");
                    let order_to_add = OrderType::Standard {
                        id: bump_id.clone(),
                        price: price_u64,
                        quantity: qty_u64,
                        side: maker_side,
                        timestamp: current_time_millis(),
                        time_in_force: TimeInForce::Gtc,
                        extra_fields: (),
                    };
                    match book.add_order(order_to_add) {
                        Err(e) => {
                            log_line(format!("self-refill add_order error at price {}: {:?}", price_u64, e));
                            log_line(format!("[ERROR] self-refill add_order px={} err={:?}", price_u64, e));
                        }
                        Ok(_) => {
                            log_line(format!("[SELF-BUMP] readded px={} qty={} as {:?}", price_u64, qty_u64, bump_id));
                        }
                    }
                } // drop book

                if let Some(ref taker_sock) = taker_sock_opt {
                    s.by_socket
                        .entry(symbol.clone())
                        .or_default()
                        .entry(taker_sock.clone())
                        .or_default()
                        .push(format!("{:?}", bump_id));
                }
            }
        }

        // --- Build taker-view transactions
        let txns = mr.transactions.as_vec().iter().map(|tx| {
            serde_json::json!({
                "quantity": (tx.quantity as f64),
                "price": (tx.price as f64) / 1e2,
                "transaction_id": tx.transaction_id,
                "maker": false
            })
        }).collect::<Vec<_>>();

        out.push(serde_json::json!({
            "order_id": format!("{:?}", mr.order_id),
            "executed_qty": mr.executed_quantity() as f64,
            "remaining_qty": mr.remaining_quantity as f64,
            "is_complete": mr.is_complete,
            "transactions": txns,
            "maker_slices": maker_slices,
            "filled_order_ids": mr.filled_order_ids.iter().map(|fid| format!("{:?}", fid)).collect::<Vec<_>>()
        }));
    }

    Ok(serde_json::to_string(&out).unwrap_or_else(|_| "[]".into()))
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
