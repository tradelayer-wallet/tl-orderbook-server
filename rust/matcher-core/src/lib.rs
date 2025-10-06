use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use hashbrown::HashMap as FastMap;

use orderbook_rs::prelude::{
  BookManager, BookManagerStd, OrderBook, OrderId, Side, current_time_millis,
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


#[inline]
fn parse_side(s: &str) -> Side {
    let side = match s.to_ascii_lowercase().as_str() {
        "buy" => Side::Buy,
        _ => Side::Sell,
    };
    println!("side parsed = {:?}", side);
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
    let mut s = STATE.lock().unwrap();

    // Ensure book exists
    if !s.man.has_book(&symbol) {
        s.man.add_book(&symbol);
    }

    // Track order by socket for later cancels
    if let Some(sock) = &order.socket_id {
        s.by_socket
            .entry(symbol.clone())
            .or_default()
            .entry(sock.clone())
            .or_default()
            .push(order.uuid.clone());
    }

    // --- Prepare parameters ---
    let book = s.man.get_book_mut(&symbol).expect("book exists");
    let id = to_order_id(&order.uuid);
    let price = to_price_u64(order.price);
    let qty = to_qty_u64(order.amount);
    let side = parse_side(&order.side);

    println!(
        "submit(): book {:p} symbol={} side={:?} price={} qty={}",
        &book, symbol, side, price, qty
    );

    // --- Execute match ---
    let mr = book
        .match_limit_order(id.clone(), qty,side, price)
        .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?;

     // Only insert if not fully matched
    if !mr.is_complete && mr.remaining_quantity > 0 {
        use orderbook_rs::prelude::{OrderType, TimeInForce};
        let order_to_add = OrderType::Standard {
            id: id.clone(),
            price,
            quantity: mr.remaining_quantity,
            side,
            timestamp: current_time_millis(),
            time_in_force: TimeInForce::Gtc,
            extra_fields: (),
        };

        book.add_order(order_to_add)
            .map_err(|e| Error::from_reason(format!("add_order: {e:?}")))?;
    }

    // --- Serialize result ---
    let txns = mr
        .transactions
        .as_vec()
        .iter()
        .map(|tx| {
            serde_json::json!({
                "quantity": tx.quantity,
                "price": tx.price,
                "transaction_id": tx.transaction_id
            })
        })
        .collect::<Vec<_>>();

    let payload = serde_json::json!({
        "order_id": format!("{:?}", mr.order_id),
        "executed_qty": (mr.executed_quantity() as f64),   // reverse internal scaling
        "remaining_qty": (mr.remaining_quantity as f64),
        "is_complete": mr.is_complete,
        "transactions": mr.transactions.as_vec().iter().map(|tx| {
            serde_json::json!({
                "quantity": (tx.quantity as f64),          // rescale too
                "price": (tx.price as f64) / 1e2,                // price back to float
                "transaction_id": tx.transaction_id
            })
        }).collect::<Vec<_>>(),
        "filled_order_ids": mr.filled_order_ids.iter()
            .map(|fid| format!("{:?}", fid))
            .collect::<Vec<_>>()
    });

    Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}

#[napi]
pub fn submit_batch(symbol: String, orders: Vec<JsOrder>) -> napi::Result<String> {
  let mut s = STATE.lock().unwrap();

  // 1) Ensure book exists
  if !s.man.has_book(&symbol) {
    s.man.add_book(&symbol);
  }

  let mut out = Vec::<serde_json::Value>::new();

  for o in orders {
    // 2) Update by_socket first (separate mutable borrow)
    if let Some(sock) = &o.socket_id {
      s.by_socket
        .entry(symbol.clone())
        .or_default()
        .entry(sock.clone())
        .or_default()
        .push(o.uuid.clone());
    }

    // 3) Borrow the book mutably only for the match call, then drop
    let mr = {
      let book = s.man.get_book_mut(&symbol).expect("book exists");
      let id = to_order_id(&o.uuid);
      let price = to_price_u64(o.price);
      let qty = to_qty_u64(o.amount);
      let side = parse_side(&o.side);
      book
        .match_limit_order(id.clone(), qty, side, price)
        .map_err(|e| Error::from_reason(format!("submit_batch: {e:?}")))?
    };

    let txns = mr
      .transactions
      .as_vec()
      .iter()
      .map(|tx| {
        serde_json::json!({
          "quantity": tx.quantity,
          "price": tx.price,
          "transaction_id": tx.transaction_id
        })
      })
      .collect::<Vec<_>>();

    out.push(serde_json::json!({
      "order_id": format!("{:?}", mr.order_id),
      "executed_qty": mr.executed_quantity(),
      "remaining_qty": mr.remaining_quantity,
      "is_complete": mr.is_complete,
      "transactions": txns,
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
    println!("snapshot(): book {:p} symbol={}", book, symbol);
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
