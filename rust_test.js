// rust_test.js
const core = require("./rust/matcher-core/matcher_core.node");

console.log("=== INITIALIZING BOOK ===");
core.createBook("ETHUSD");

function parse(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch {
      console.warn("⚠️ Could not parse JSON:", res);
    }
  }
  return res;
}

//
// === STEP 1: add 5-lot bid ===
//
const buyRes = parse(
  core.submit("ETHUSD", { uuid: "b1", side: "BUY", price: 1100, amount: 5 })
);
console.log("buy big", buyRes);

//
// === STEP 2: sequential sells ===
//

// (a) first hit: 2 @1000
const sell1 = parse(
  core.submit("ETHUSD", { uuid: "s1", side: "SELL", price: 1000, amount: 2 })
);
console.log("sell1", sell1);

// (b) second hit: 1 @1000
const sell2 = parse(
  core.submit("ETHUSD", { uuid: "s2", side: "SELL", price: 1025, amount: 1 })
);
console.log("sell2", sell2);

// (c) final hit: 2 @1000
const sell3 = parse(
  core.submit("ETHUSD", { uuid: "s3", side: "SELL", price: 1100, amount: 3 })
);
console.log("sell3", sell3);

//
// === STEP 3: verify outcomes ===
//

// cumulative executed = 5
const totalExec = sell1.executed_qty + sell2.executed_qty + sell3.executed_qty;
if (totalExec !== 5.0)
  throw new Error(`Expected total executed 5.0, got ${totalExec}`);

// after final fill, book should be empty on bids
console.log("=== POST-MATCH SNAPSHOT ===");
const snap = parse(core.snapshot("ETHUSD", 5));
console.log(JSON.stringify(snap, null, 2));

const bids = snap.snapshot?.bids ?? [];
if (bids.length !== 0)
  throw new Error(
    `Expected book to clear after cumulative sells, found ${bids.length} bids`
  );

console.log("✅ Multi-match test passed — cumulative fills correct and book cleared.");
