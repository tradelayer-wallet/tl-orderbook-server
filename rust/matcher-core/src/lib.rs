use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use hashbrown::HashMap as FastMap;

// This matches the 7c0ad8… layout:
use orderbook_rs::prelude::{BookManager, BookManagerStd, Side, OrderId};
use pricelevel::orders::base::{Order as ObOrder, Price as ObPrice, Qty as ObQty};


#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct JsOrder {
  pub uuid: String,
  pub side: String,      // "BUY" | "SELL"
  pub price: f64,
  pub amount: f64,
  pub socket_id: Option<String>,
}

#[derive(Default)]
struct State {
  man: BookManagerStd<String>,
  by_socket: HashMap<String, FastMap<String, Vec<String>>>,
}



static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

#[napi]
pub fn create_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.entry(symbol.clone()).or_default();
  s.man.create_book(symbol).is_ok()
}

#[napi]
pub fn drop_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.remove(&symbol);
  s.man.drop_book(symbol).is_ok()
}

#[napi]
pub fn submit(symbol: String, order: JsOrder) -> napi::Result<String> {
// was: OrderBookSide::Bid / OrderBookSide::Ask
let side = match order.side.as_str() {
  "BUY" | "buy" => Side::Bid,
  _ => Side::Ask,
};



  // In 7c0ad8… ObId is a tuple wrapper around a String
  let ob = ObOrder {
    id: ObId(order.uuid.clone()),
    side,
    price: ObPrice(order.price),
    qty: ObQty(order.amount),
  };

  let mut s = STATE.lock().unwrap();

  if let Some(sock) = &order.socket_id {
    s.by_socket
      .entry(symbol.clone())
      .or_default()
      .entry(sock.clone())
      .or_default()
      .push(order.uuid.clone());
  }

  let trades = s
    .man
    .submit(&symbol, ob)
    .map_err(|e| Error::from_reason(format!("submit: {e:?}")))?;

  let payload = serde_json::json!({
    "fills": trades
      .into_iter()
      .map(|t| serde_json::json!({
        "maker": t.maker.0,
        "taker": t.taker.0,
        "price": t.price.0,
        "amount": t.qty.0
      }))
      .collect::<Vec<_>>()
  });

  Ok(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()))
}

#[napi]
pub fn submit_batch(symbol: String, orders: Vec<JsOrder>) -> napi::Result<String> {
  let mut s = STATE.lock().unwrap();
  let mut all = Vec::<serde_json::Value>::new();

  for o in orders {
    let side = match o.side.as_str() {
      "BUY" | "buy" => OrderBookSide::Bid,
      _ => OrderBookSide::Ask,
    };
    let ob = ObOrder {
      id: ObId(o.uuid.clone()),
      side,
      price: ObPrice(o.price),
      qty: ObQty(o.amount),
    };

    if let Some(sock) = &o.socket_id {
      s.by_socket
        .entry(symbol.clone())
        .or_default()
        .entry(sock.clone())
        .or_default()
        .push(o.uuid.clone());
    }

    let trades = s
      .man
      .submit(&symbol, ob)
      .map_err(|e| Error::from_reason(format!("submit_batch: {e:?}")))?;

    let fills: Vec<serde_json::Value> = trades
      .into_iter()
      .map(|t| serde_json::json!({
        "maker": t.maker.0,
        "taker": t.taker.0,
        "price": t.price.0,
        "amount": t.qty.0
      }))
      .collect();

    all.push(serde_json::json!({ "fills": fills }));
  }

  Ok(serde_json::to_string(&all).unwrap_or_else(|_| "[]".into()))
}

#[napi]
pub fn cancel(symbol: String, order_id: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.man.cancel(&symbol, ObId(order_id)).is_ok()
}

#[napi]
pub fn cancel_all_by_socket(symbol: String, socket_id: String) -> u32 {
  let mut s = STATE.lock().unwrap();
  let mut n = 0u32;

  if let Some(idx) = s.by_socket.get_mut(&symbol) {
    if let Some(list) = idx.remove(&socket_id) {
      for oid in list {
        if s.man.cancel(&symbol, ObId(oid)).is_ok() {
          n += 1;
        }
      }
    }
  }
  n
}

#[napi]
pub fn snapshot(symbol: String, depth: Option<u32>) -> String {
  let d = depth.unwrap_or(20) as usize;
  let s = STATE.lock().unwrap();
  serde_json::to_string(&s.man.snapshot(&symbol, d)).unwrap_or_else(|_| "{}".into())
}

#[napi]
pub fn stats(symbol: String) -> String {
  let s = STATE.lock().unwrap();
  serde_json::to_string(&s.man.stats(&symbol)).unwrap_or_else(|_| "{}".into())
}
