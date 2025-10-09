// rust_test.js
const core = require("./rust/matcher-core/matcher_core.node");
console.log(Object.keys(core).sort());
console.log('napi version:', process.versions.napi);

function parse(x){ try { return typeof x === 'string' ? JSON.parse(x) : x } catch { return x } }
const show = (label, obj) => { console.log(`\n=== ${label} ===`); console.log(JSON.stringify(parse(obj), null, 2)); };

console.log("=== INITIALIZING BOOK ===");
core.createBook("ETHUSD");

// choose socket ids
const MAKER_SOCK = "sock-maker-1";
const TAKER_SOCK = "sock-taker-1";

// 1) place a 5-lot bid (maker) — give it a socket id too if you want ownership
core.submit("ETHUSD", { uuid: "b1", side: "BUY",  price: 1100, amount: 5, socketId: MAKER_SOCK });

// 2) three sells; the last one will leave 1 resting on the ask
core.submit("ETHUSD", { uuid: "s1", side: "SELL", price: 1000, amount: 2, socketId: TAKER_SOCK });
core.submit("ETHUSD", { uuid: "s2", side: "SELL", price: 1025, amount: 1, socketId: TAKER_SOCK });
core.submit("ETHUSD", { uuid: "s3", side: "SELL", price: 1100, amount: 3, socketId: TAKER_SOCK });

// Inspect
show("snapshot(ETHUSD,5)", core.snapshot("ETHUSD", 5));

show("debug_socket(ETHUSD, TAKER_SOCK)",
  core.debugSocket("ETHUSD", TAKER_SOCK));

// This should now show the **external** uuids owned by that socket that are RESTING (here: "s3")
show("getOpenOrdersBySocket(TAKER_SOCK, ETHUSD)", core.getOpenOrdersBySocket(TAKER_SOCK, "ETHUSD"));

// If you want history:
if (core.getOrderHistoryBySocket) {// correct order: (market, socketId, limit)
show(
  "getOrderHistoryBySocket(TAKER_SOCK, ETHUSD, 50)",
  core.getOrderHistoryBySocket("ETHUSD", TAKER_SOCK, 50)
);
}
