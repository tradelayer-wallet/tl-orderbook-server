use napi::bindgen_prelude::*;
use napi_derive::napi;
use napi::JsObject;
use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use hashbrown::HashMap as FastMap;

use orderbook_rs::orderbook::{BookManagerStd, OrderBookSide};
use orderbook_rs::types::{Order as ObOrder, OrderId as ObId, Price as ObPrice, Qty as ObQty};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsOrder {
  pub uuid: String,
  pub side: String,
  pub price: f64,
  pub amount: f64,
  pub socket_id: Option<String>,
}

#[derive(Default)]
struct State {
  man: BookManagerStd,
  by_socket: HashMap<String, FastMap<String, Vec<String>>>, // symbol -> socket -> [orderIds]
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

#[napi] pub fn create_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.entry(symbol.clone()).or_default();
  s.man.create_book(symbol).is_ok()
}
#[napi] pub fn drop_book(symbol: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.by_socket.remove(&symbol);
  s.man.drop_book(symbol).is_ok()
}

#[napi] pub fn submit(symbol: String, order: JsObject) -> napi::Result<JsObject> {
  let js: JsOrder = napi::bindgen_prelude::from_js_value(order)?;
  let side = match js.side.as_str() { "BUY"|"buy" => OrderBookSide::Bid, _ => OrderBookSide::Ask };
  let ob = ObOrder { id: ObId(js.uuid.clone()), side, price: ObPrice(js.price), qty: ObQty(js.amount) };

  let mut s = STATE.lock().unwrap();
  if let Some(sock) = js.socket_id.clone() {
    s.by_socket.entry(symbol.clone()).or_default().entry(sock).or_default().push(js.uuid.clone());
  }
  let trades = s.man.submit(&symbol, ob).map_err(|e| Error::from_reason(format!("submit: {e:?}")))?;

  let ret = serde_json::json!({
    "fills": trades.into_iter().map(|t| {
      serde_json::json!({"maker": t.maker.0, "taker": t.taker.0, "price": t.price.0, "amount": t.qty.0})
    }).collect::<Vec<_>>()
  });

  let env = unsafe { Env::from_raw(napi::sys::napi_get_current_env().unwrap()) };
  env.to_js_value(&ret)
}

#[napi] pub fn submit_batch(symbol: String, orders: Vec<JsObject>) -> napi::Result<JsObject> {
  let mut all = Vec::<serde_json::Value>::new();
  for o in orders {
    let obj: JsObject = submit(symbol.clone(), o)?;
    let env = unsafe { Env::from_raw(napi::sys::napi_get_current_env().unwrap()) };
    let v: serde_json::Value = env.from_js_value(obj)?;
    all.push(v);
  }
  let env = unsafe { Env::from_raw(napi::sys::napi_get_current_env().unwrap()) };
  env.to_js_value(&all)
}

#[napi] pub fn cancel(symbol: String, order_id: String) -> bool {
  let mut s = STATE.lock().unwrap();
  s.man.cancel(&symbol, ObId(order_id)).is_ok()
}

#[napi] pub fn cancel_all_by_socket(symbol: String, socket_id: String) -> u32 {
  let mut s = STATE.lock().unwrap();
  let mut n = 0u32;
  if let Some(idx) = s.by_socket.get_mut(&symbol) {
    if let Some(list) = idx.remove(&socket_id) {
      for oid in list { if s.man.cancel(&symbol, ObId(oid)).is_ok() { n += 1; } }
    }
  }
  n
}

#[napi] pub fn snapshot(symbol: String, depth: Option<u32>) -> String {
  let d = depth.unwrap_or(20) as usize;
  let s = STATE.lock().unwrap();
  serde_json::to_string(&s.man.snapshot(&symbol, d)).unwrap_or_else(|_| "{}".into())
}

#[napi] pub fn stats(symbol: String) -> String {
  let s = STATE.lock().unwrap();
  serde_json::to_string(&s.man.stats(&symbol)).unwrap_or_else(|_| "{}".into())
}
