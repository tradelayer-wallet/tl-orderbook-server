#!/usr/bin/env node
'use strict';
// Deterministic spot-market order stream shared by the Rust and legacy throughput benches.
//   node gen-workload.cjs <cross|deep> <count> <seed> > workload.tsv
// Columns: id sock addr act desired sale price amount
// Safe domain of the parity harness: prices are multiples of 0.01, amounts of 0.001, so the
// legacy double arithmetic (toFixed(6)) equals exact decimal arithmetic.
//   cross: a random-walk mid; each order is priced within +-0.30 of it, about half cross.
//   deep:  the first 80% rest far from mid (buys 1.00-1.99, sells 3.01-4.00, never crossing);
//          the last 20% are aggressive takers that sweep the book.

const [mode, nStr, seedStr] = process.argv.slice(2);
const n = parseInt(nStr, 10);
if (!['cross', 'deep'].includes(mode) || !(n > 0)) {
  console.error('usage: gen-workload.cjs <cross|deep> <count> <seed>');
  process.exit(2);
}
let s = (parseInt(seedStr || '1', 10) >>> 0) || 1;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const SESSIONS = 200;

const out = [];
let mid = 250; // cents
for (let id = 1; id <= n; id++) {
  const sock = ri(1, SESSIONS);
  const addr = 'A' + sock;
  const buy = rnd() < 0.5;
  let cents;
  if (mode === 'cross') {
    mid = Math.min(450, Math.max(150, mid + ri(-1, 1)));
    cents = mid + (buy ? ri(-30, 15) : ri(-15, 30));
  } else if (id <= Math.floor(n * 0.8)) {
    cents = buy ? ri(100, 199) : ri(301, 400);
  } else {
    cents = buy ? 400 : 100;
  }
  const amount = (mode === 'deep' && id > Math.floor(n * 0.8)) ? ri(1000, 20000) : ri(1, 5000);
  const [desired, sale] = buy ? [1, 2] : [2, 1];
  out.push([id, sock, addr, buy ? 'BUY' : 'SELL', desired, sale, (cents / 100).toFixed(2), (amount / 1000).toFixed(3)].join('\t'));
}
process.stdout.write(out.join('\n') + '\n');
