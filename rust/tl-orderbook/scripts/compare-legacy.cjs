#!/usr/bin/env node
'use strict';
// Legacy parity harness for tl-orderbook.
//
// Loads the compiled legacy matcher (src/services/orderbook/orderbook.class.js, the tsc output of
// orderbook.class.ts; its checkMatch/addOrder/buildTrade bodies were compared against the .ts by
// reading) with only its I/O collaborators stubbed (socket service, swap channel, order manager,
// moment). `mix.pure.js` (safeNumber) is the real legacy file; its two log writers are replaced by
// no-ops so nothing touches the disk. Every swap "settles" immediately.
//
//   node scripts/compare-legacy.cjs --write   regenerate tests/fixtures/{parity_cases,parity_expected}.txt
//   node scripts/compare-legacy.cjs --check    re-run the legacy code and compare with the committed files
//
// Safe domain: amounts are multiples of 0.001 and prices multiples of 0.01, so the legacy double
// arithmetic rounded with toFixed(6) equals exact decimal arithmetic. Fixtures contain no dust
// (every amount >= 0.001) and no session/book limits are exercised.
//
// Pinned legacy blobs (git rev-parse HEAD:<path> at base 909332c):
//   src/services/orderbook/orderbook.class.js  449b450cf8e87a6ec5b8a85be8a7d49f0689402d is the last
//   commit touching it; blob SHAs are printed by --blobs.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CRATE = path.resolve(__dirname, '..');
const OB = path.join(ROOT, 'src/services/orderbook/orderbook.class.js');
const MIX = path.join(ROOT, 'src/utils/pure/mix.pure.js');
const CASES = path.join(CRATE, 'tests/fixtures/parity_cases.txt');
const EXPECTED = path.join(CRATE, 'tests/fixtures/parity_expected.txt');

// ---------------------------------------------------------------- stubs + legacy load
const swaps = [];
class StubChannelSwap {
  constructor(client, dealer, tradeInfo, unfilled) { swaps.push({ tradeInfo, unfilled }); }
  onReady() { return Promise.resolve({ data: { txid: 'tx' } }); }
}
const stubs = {
  '../socket': { socketService: { io: { emit() {}, sockets: { sockets: { get: () => ({ emit() {} }) } } } } },
  '../channel-swap/channel-swap.class': { ChannelSwap: StubChannelSwap },
  '.': { orderbookManager: { getOrdersBySocketId: () => [], getOrdersHistory: () => [] } },
};
const momentStub = () => ({ format: () => 'x', subtract() { return this; } });
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === OB && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (request === 'moment') return momentStub;
  return origLoad.apply(this, arguments);
};
const mix = require(MIX);
mix.saveLog = () => {};
mix.updateOrderLog = () => {};
const { Orderbook } = require(OB);

// ---------------------------------------------------------------- fixture text format
// case <name>
// market spot <a> <b> | market futures <contract>
// rest|take id= sock= addr= act=BUY|SELL [desired= sale=] [contract= lev= coll=] price= amount= [lock=1] [notrades=1]
// end
function fmt(n, d) { return Number(n).toFixed(d); }

function serialize(cases) {
  const out = [];
  for (const c of cases) {
    out.push(`case ${c.name}`);
    out.push(c.market.type === 'spot' ? `market spot ${c.market.a} ${c.market.b}` : `market futures ${c.market.contract}`);
    for (const [kind, o] of [...c.rest.map((o) => ['rest', o]), ['take', c.take]]) {
      let l = `${kind} id=${o.id} sock=${o.sock} addr=${o.addr} act=${o.act}`;
      if (o.type === 'spot') l += ` desired=${o.desired} sale=${o.sale}`;
      else l += ` contract=${o.contract} lev=${o.lev} coll=${o.coll}`;
      l += ` price=${o.price} amount=${o.amount}`;
      if (o.lock) l += ' lock=1';
      if (o.notrades) l += ' notrades=1';
      out.push(l);
    }
    out.push('end');
  }
  return out.join('\n') + '\n';
}

function parse(text) {
  const cases = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'case') cur = { name: parts[1], rest: [], take: null, market: null };
    else if (parts[0] === 'market') cur.market = parts[1] === 'spot' ? { type: 'spot', a: +parts[2], b: +parts[3] } : { type: 'futures', contract: +parts[2] };
    else if (parts[0] === 'rest' || parts[0] === 'take') {
      const kv = {};
      for (const p of parts.slice(1)) { const i = p.indexOf('='); kv[p.slice(0, i)] = p.slice(i + 1); }
      const o = { id: +kv.id, sock: +kv.sock, addr: kv.addr, act: kv.act, price: kv.price, amount: kv.amount, lock: kv.lock === '1', notrades: kv.notrades === '1' };
      if (kv.desired !== undefined) { o.type = 'spot'; o.desired = +kv.desired; o.sale = +kv.sale; } else { o.type = 'futures'; o.contract = +kv.contract; o.lev = kv.lev; o.coll = +kv.coll; }
      if (parts[0] === 'rest') cur.rest.push(o); else cur.take = o;
    } else if (parts[0] === 'end') { cases.push(cur); cur = null; }
  }
  return cases;
}

// ---------------------------------------------------------------- case generation
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function generate() {
  const cases = [];
  const spot = (id, sock, addr, act, desired, sale, price, amount, extra) => ({ type: 'spot', id, sock, addr, act, desired, sale, price, amount, ...extra });
  const fut = (id, sock, addr, act, price, amount, lev, extra) => ({ type: 'futures', id, sock, addr, act, contract: 5, lev, coll: 1, price, amount, ...extra });
  const m = { type: 'spot', a: 1, b: 2 };
  // hand-written cases
  cases.push({ name: 'empty_book_places', market: m, rest: [], take: spot(9, 1, 'A1', 'BUY', 1, 2, '2.50', '1.500') });
  cases.push({ name: 'exact_fill', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.50', '1.500')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '2.50', '1.500') });
  cases.push({ name: 'taker_partial_then_rests', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.50', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '2.500') });
  cases.push({ name: 'maker_partial', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.50', '4.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.250') });
  cases.push({ name: 'price_priority_buy', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.80', '1.000'), spot(2, 3, 'A3', 'SELL', 2, 1, '2.40', '1.000'), spot(3, 4, 'A4', 'SELL', 2, 1, '2.60', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'price_priority_sell', market: m, rest: [spot(1, 1, 'A1', 'BUY', 1, 2, '2.80', '1.000'), spot(2, 3, 'A3', 'BUY', 1, 2, '2.40', '1.000'), spot(3, 4, 'A4', 'BUY', 1, 2, '2.90', '1.000')], take: spot(9, 2, 'A2', 'SELL', 2, 1, '2.00', '1.000') });
  cases.push({ name: 'time_priority_tie', market: m, rest: [spot(1, 3, 'A3', 'SELL', 2, 1, '2.50', '1.000'), spot(2, 4, 'A4', 'SELL', 2, 1, '2.50', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '2.50', '1.000') });
  cases.push({ name: 'sweeps_three_levels', market: m, rest: [spot(1, 3, 'A3', 'SELL', 2, 1, '2.40', '1.000'), spot(2, 4, 'A4', 'SELL', 2, 1, '2.50', '1.000'), spot(3, 5, 'A5', 'SELL', 2, 1, '2.60', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '2.60', '2.500') });
  cases.push({ name: 'price_not_crossing', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '3.50', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'locked_skipped', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.40', '1.000', { lock: true }), spot(2, 3, 'A3', 'SELL', 2, 1, '2.60', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'same_session_errors', market: m, rest: [spot(1, 2, 'A1', 'SELL', 2, 1, '2.40', '1.000'), spot(2, 3, 'A3', 'SELL', 2, 1, '2.60', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'same_address_errors', market: m, rest: [spot(1, 1, 'AX', 'SELL', 2, 1, '2.40', '1.000')], take: spot(9, 2, 'AX', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'wrong_direction_ids_do_not_cross', market: m, rest: [spot(1, 1, 'A1', 'SELL', 1, 2, '2.40', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000') });
  cases.push({ name: 'batch_crossing_skipped', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '2.40', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000', { notrades: true }) });
  cases.push({ name: 'batch_non_crossing_placed', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '3.40', '1.000')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '3.00', '1.000', { notrades: true }) });
  cases.push({ name: 'rounding_small_notional', market: m, rest: [spot(1, 1, 'A1', 'SELL', 2, 1, '0.01', '0.001')], take: spot(9, 2, 'A2', 'BUY', 1, 2, '0.01', '0.001') });
  const fm = { type: 'futures', contract: 5 };
  cases.push({ name: 'futures_exact', market: fm, rest: [fut(1, 1, 'A1', 'SELL', '100.00', '2.000', '5')], take: fut(9, 2, 'A2', 'BUY', '100.00', '2.000', '3') });
  cases.push({ name: 'futures_partial_maker_price', market: fm, rest: [fut(1, 1, 'A1', 'SELL', '99.00', '5.000', '5')], take: fut(9, 2, 'A2', 'BUY', '101.00', '2.000', '3') });
  cases.push({ name: 'futures_sell_taker_buyer_leverage', market: fm, rest: [fut(1, 1, 'A1', 'BUY', '101.00', '1.000', '7')], take: fut(9, 2, 'A2', 'SELL', '100.00', '3.000', '2') });

  // pseudo-random cases
  const rnd = lcg(20261030);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const px = () => fmt(ri(100, 300) / 100, 2);
  const am = () => fmt(ri(1, 5000) / 1000, 3);
  for (let n = 0; n < 300; n++) {
    const futures = rnd() < 0.25;
    const market = futures ? fm : m;
    const mk = (id, take) => {
      const sock = ri(1, 4);
      const addr = 'A' + (rnd() < 0.9 ? sock : ri(1, 5));
      const act = rnd() < 0.5 ? 'BUY' : 'SELL';
      if (futures) return fut(id, sock, addr, act, px(), am(), String(ri(1, 10)), { lock: !take && rnd() < 0.1 });
      // makers mostly in the canonical direction for their side, takers likewise, with some wrong-direction noise
      const canonical = act === 'BUY' ? [1, 2] : [2, 1];
      const d = rnd() < 0.9 ? canonical : [canonical[1], canonical[0]];
      return spot(id, sock, addr, act, d[0], d[1], px(), am(), { lock: !take && rnd() < 0.1 });
    };
    const rest = [];
    const k = ri(0, 8);
    for (let i = 1; i <= k; i++) rest.push(mk(i, false));
    const take = mk(100, true);
    take.lock = false;
    if (rnd() < 0.1) take.notrades = true;
    cases.push({ name: `rand_${String(n).padStart(3, '0')}`, market, rest, take });
  }
  return cases;
}

// ---------------------------------------------------------------- legacy runner
function toLegacy(o, market) {
  const base = {
    uuid: String(o.id), timestamp: 0, socket_id: String(o.sock), lock: !!o.lock,
    keypair: { address: o.addr, pubkey: 'pk' + o.sock }, action: o.act, isLimitOrder: true, marketName: 'm',
  };
  if (o.type === 'spot') return { ...base, type: 'SPOT', props: { id_desired: o.desired, id_for_sale: o.sale, amount: parseFloat(o.amount), price: parseFloat(o.price) } };
  return { ...base, type: 'FUTURES', props: { contract_id: o.contract, amount: parseFloat(o.amount), price: parseFloat(o.price), levarage: parseFloat(o.lev), collateral: o.coll } };
}

function tradeLine(t) {
  const i = t.tradeInfo;
  const p = i.props;
  let l = `trade type=${i.type} buyer=${i.buyer.socketId}/${i.buyer.keypair.address} seller=${i.seller.socketId}/${i.seller.keypair.address} taker=${i.taker} maker=${i.maker}`;
  if (i.type === 'SPOT') l += ` desired=${p.propIdDesired} sale=${p.propIdForSale} amtD=${fmt(p.amountDesired, 6)} amtS=${fmt(p.amountForSale, 6)}`;
  else l += ` contract=${p.contract_id} amount=${fmt(p.amount, 6)} price=${fmt(p.price, 6)} lev=${fmt(p.levarage, 6)} coll=${p.collateral}`;
  l += ' unfilled=' + (t.unfilled ? `${t.unfilled.uuid}:${fmt(t.unfilled.props.amount, 6)}` : 'none');
  return l;
}

async function runCase(c) {
  swaps.length = 0;
  const first = toLegacy({ ...c.rest[0] || c.take, id: 0 }, c.market);
  const realLog = console.log;
  console.log = () => {};
  const ob = new Orderbook(first);
  console.log = realLog;
  ob.orders = c.rest.map((o) => toLegacy(o, c.market));
  let anyError = null;
  const orig = ob.addOrder.bind(ob);
  let skipped = false;
  ob.addOrder = async (order, noTrades) => {
    const res = await orig(order, noTrades);
    if (res === undefined) skipped = true;
    else if (res.error && anyError === null) anyError = res.error;
    return res;
  };
  await ob.addOrder(toLegacy(c.take, c.market), !!c.take.notrades);
  const out = [`case ${c.name}`];
  for (const s of swaps) out.push(tradeLine(s));
  out.push(anyError !== null ? `final error=${anyError}` : skipped ? 'final skipped' : 'final ok');
  for (const o of ob.orders) out.push(`book ${o.uuid} ${o.action} price=${fmt(o.props.price, 6)} amount=${fmt(o.props.amount, 6)} lock=${o.lock ? 1 : 0}`);
  out.push('end');
  return out.join('\n');
}

async function runAll(cases) {
  const out = [];
  for (const c of cases) out.push(await runCase(c));
  return out.join('\n') + '\n';
}

(async () => {
  const mode = process.argv[2];
  if (mode === '--blobs') {
    for (const f of ['src/services/orderbook/orderbook.class.js', 'src/services/orderbook/orderbook.class.ts', 'src/utils/pure/mix.pure.js']) {
      console.log(f, execFileSync(process.env.GIT || 'git', ['-C', ROOT, 'rev-parse', `HEAD:${f}`]).toString().trim());
    }
    return;
  }
  if (mode === '--write') {
    const cases = generate();
    fs.mkdirSync(path.dirname(CASES), { recursive: true });
    fs.writeFileSync(CASES, serialize(cases));
    fs.writeFileSync(EXPECTED, await runAll(parse(fs.readFileSync(CASES, 'utf8'))));
    console.log(`wrote ${cases.length} cases`);
    return;
  }
  if (mode === '--check') {
    const text = fs.readFileSync(CASES, 'utf8').replace(/\r\n/g, '\n');
    if (serialize(generate()) !== text) { console.error('parity_cases.txt is stale: run --write'); process.exit(1); }
    const got = await runAll(parse(text));
    const want = fs.readFileSync(EXPECTED, 'utf8').replace(/\r\n/g, '\n');
    if (got !== want) { console.error('legacy output differs from parity_expected.txt'); process.exit(1); }
    console.log('legacy output matches the committed expectation');
    return;
  }
  console.error('usage: compare-legacy.cjs --write | --check | --blobs');
  process.exit(2);
})().catch((e) => { console.error(e); process.exit(1); });
