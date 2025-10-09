const core = require("./rust/matcher-core/matcher_core.node");
console.log(Object.keys(core).sort());
// Optional sanity
console.log('napi version:', process.versions.napi);
function parse(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch {
      console.warn("⚠️ Could not parse JSON:", res);
      return res;
    }
  }
  return res;
}

// --- Helper ---
function show(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(parse(obj), null, 2));
}

// ------------------------------------------------------------
// 0. Setup
// ------------------------------------------------------------
console.log("=== INITIALIZING BOOK ===");
core.createBook("ETHUSD");

// ------------------------------------------------------------
// 1. Submit a few orders
// ------------------------------------------------------------
core.submit("ETHUSD", { uuid: "b1", side: "BUY", price: 1100, amount: 5 });
core.submit("ETHUSD", { uuid: "s1", side: "SELL", price: 1000, amount: 2 });
core.submit("ETHUSD", { uuid: "s2", side: "SELL", price: 1025, amount: 1 });
core.submit("ETHUSD", { uuid: "s3", side: "SELL", price: 1100, amount: 3 });

// ------------------------------------------------------------
// 2. Inspect current state via existing public methods
// ------------------------------------------------------------
show("snapshot(ETHUSD,5)", core.snapshot("ETHUSD", 5));
show(
  "getOpenOrdersBySocket(<socket_id>, ETHUSD)",
  core.getOpenOrdersBySocket("1760025034318-snbszo7", "ETHUSD")
);
show("int2ext map", core.get_int2ext ? core.get_int2ext("ETHUSD") : "{}");
show("books list", core.listBooks ? core.listBooks() : "{}");

// optional: if you track sockets internally
if (core.listSockets) show("listSockets()", core.listSockets());

// ------------------------------------------------------------
// 3. Optional verify logic (match coverage test)
// ------------------------------------------------------------
const snap = parse(core.snapshot("ETHUSD", 5));
const bids = snap.snapshot?.bids ?? [];
const asks = snap.snapshot?.asks ?? [];
console.log(`\nBook depth: bids=${bids.length}, asks=${asks.length}`);
