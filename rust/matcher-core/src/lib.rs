use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// High-perf map for per-socket order tracking (kept to match your TS semantics)
use hashbrown::HashMap as FastMap;

// Pull what this commit actually exports
use orderbook_rs::prelude::{
  BookManager, BookManagerStd, OrderBook, OrderId, OrderType, Side, TimeInForce,
  current_time_millis,
};

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
  // Generic payload type T = () keeps things simple across APIs
  man: BookManagerStd<()>,
  // symbol -> socket -> [orderIds] (kept for parity; ids are placeholders until we wire real OrderId)
  by_socket: HashMap<String, FastMap<String, Vec<String>>>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

#[inline]
fn to_price_u64(p: f64) -> u64 {
  // Adjust this to your price scale; this commit uses u64 prices.
  // For raw integer ticks, floor() is fine. If you have decimals, scale first.
  if p.is_finite() && p > 0.0 { p.floor() as u64 } else { 0 }
}

#[inline]
fn to_qty_u64(q: f64) -> u64 {
  if q.is_finite() && q > 0.0 { q.floor() as u64 } else { 0 }
}

#[inline]
fn parse_side(s: &str) -> Side {
  match s.to_ascii_lowercase().as_str() {
    "buy" => Side::Buy,
    _ => Side::Sell,
  }
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

fn build_limit_order(js: &JsOrder) -> OrderType<()> {
  // NOTE: Using OrderId::default() for now; swap to a real constructor once confirmed
  let id = OrderId::default();
  let side = parse_side(&js.side);
  let price = to_price_u64(js.price);
  let quantity = to_qty_u64(js.amount);
  let tif = TimeInForce::GTC;
  let ts = current_time_millis();

  // This shape matches the Standard variant used in convert_from_unit_type in book.rs
  OrderType::Standard {
    id,
    price,
    quantity,
    side,
    timestamp: ts,
    time_in_force: tif,
    extra_fields: (), // because we use T = ()
  }
}

#[napi]
pub fn submit(symbol: String, order: JsOrder) -> napi::Result<String> {
  let mut s = STATE.lock().unwrap();
  let book: &mut OrderBook<()> = match s.man.get_book_mut(&symbol) {
    Some(b) => b,
    None => {
      // Auto-create for convenience
      s.man.add_book(&symbol);
      s.man.get_book_mut(&symbol).expect("book just added")
    }
  };

  if let Some(sock) = &order.socket_id {
    s.by_socket
      .entry(symbol.clone())
      .or_default()
      .entry(sock.clone())
      .or_default()
      .push(order.uuid.clone());
  }

  let limit = build_limit_order(&order);

  // Entry point present on your commit
  let trade_res = book
    .match_limit_order(limit)
    .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?;

  // Flatten transactions -> simple JSON
  let txns = trade_res
    .match_result
    .transactions
    .as_vec()
    .iter()
    .map(|tx| {
      // These fields exist per the book’s logging in process_trade_event
      serde_json::json!({
        "quantity": tx.quantity,
        "price": tx.price,
        "transaction_id": tx.transaction_id
      })
    })
    .collect::<Vec<_>>();

  let payload = serde_json::json!({
    "symbol": trade_res.symbol,
    "executed_qty": trade_res.match_result.executed_quantity(),
    "transactions": txns
  });

  Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}

#[napi]
pub fn submit_batch(symbol: String, orders: Vec<JsOrder>) -> napi::Result<String> {
  let mut s = STATE.lock().unwrap();
  let book: &mut OrderBook<()> = match s.man.get_book_mut(&symbol) {
    Some(b) => b,
    None => {
      s.man.add_book(&symbol);
      s.man.get_book_mut(&symbol).expect("book just added")
    }
  };

  let mut out = Vec::<serde_json::Value>::new();

  for o in orders {
    if let Some(sock) = &o.socket_id {
      s.by_socket
        .entry(symbol.clone())
        .or_default()
        .entry(sock.clone())
        .or_default()
        .push(o.uuid.clone());
    }

    let limit = build_limit_order(&o);
    let res = book
      .match_limit_order(limit)
      .map_err(|e| Error::from_reason(format!("submit_batch: {e:?}")))?;

    let txns = res
      .match_result
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
      "symbol": res.symbol,
      "executed_qty": res.match_result.executed_quantity(),
      "transactions": txns
    }));
  }

  Ok(serde_json::to_string(&out).unwrap_or_else(|_| "[]".into()))
}

#[napi]
pub fn cancel(_symbol: String, _order_id: String) -> bool {
  // This commit’s public API doesn’t expose cancel/remove by id on OrderBook.
  // If a public remove appears, wire it here. For now, no-op:
  false
}

#[napi]
pub fn cancel_all_by_socket(symbol: String, socket_id: String) -> u32 {
  // Same story: no public cancel; just drop the index entries and return 0.
  let mut s = STATE.lock().unwrap();
  if let Some(idx) = s.by_socket.get_mut(&symbol) {
    idx.remove(&socket_id);
  }
  0
}

#[napi]
pub fn snapshot(symbol: String, depth: Option<u32>) -> String {
  let s = STATE.lock().unwrap();
  if let Some(book) = s.man.get_book(&symbol) {
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
    });
    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into())
  } else {
    "{}".into()
  }
}
