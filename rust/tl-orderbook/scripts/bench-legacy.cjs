#!/usr/bin/env node
'use strict';
// Throughput bench of the legacy compiled matcher (orderbook.class.js) on a workload from
// gen-workload.cjs. Same stubs as compare-legacy.cjs: socket emits, order manager, moment and the
// two log writers are no-ops, and every swap settles immediately. Real deployments also write a
// log file per order/trade and scan all orders per update, so these numbers are an UPPER bound
// for the legacy server.
//   node bench-legacy.cjs <workload.tsv> <trace-out.txt>
// Prints one JSON line: orders, trades, errors, wall_ms, orders_per_sec, latency percentiles
// (microseconds per submitted order, including its fills) and peak RSS; writes the trade trace plus
// final book to <trace-out.txt> in the format shared with examples/throughput.rs.

const Module = require('module');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OB = path.join(ROOT, 'src/services/orderbook/orderbook.class.js');
const MIX = path.join(ROOT, 'src/utils/pure/mix.pure.js');

const trades = [];
class StubChannelSwap {
  constructor(client, dealer, tradeInfo, unfilled) { trades.push({ tradeInfo, unfilled }); }
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

function fmt(n, d) { return Number(n).toFixed(d); }

function load(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [id, sock, addr, act, desired, sale, price, amount] = l.split('\t');
    return {
      uuid: id, timestamp: 0, socket_id: sock, lock: false,
      keypair: { address: addr, pubkey: 'pk' + sock }, action: act, isLimitOrder: true, marketName: 'm',
      type: 'SPOT', props: { id_desired: +desired, id_for_sale: +sale, amount: parseFloat(amount), price: parseFloat(price) },
    };
  });
}

function vmHwmKb() {
  try { return +(/VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]); } catch { return null; }
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

(async () => {
  const orders = load(process.argv[2]);
  const realLog = console.log;
  console.log = () => {};
  // The constructor places its first order and reads a 'logs' directory (missing -> logged).
  const ob = new Orderbook(orders[0]);
  await Promise.resolve();
  const lat = new Float64Array(orders.length - 1);
  let errors = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 1; i < orders.length; i++) {
    const a = process.hrtime.bigint();
    const res = await ob.addOrder(orders[i]);
    lat[i - 1] = Number(process.hrtime.bigint() - a) / 1000;
    if (res && res.error) errors++;
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log = realLog;

  const lines = [];
  for (const t of trades) {
    const i = t.tradeInfo;
    lines.push(`trade ${i.taker} ${i.maker} ${fmt(i.props.amountDesired, 6)} ${fmt(i.props.amountForSale, 6)}`);
  }
  for (const o of ob.orders) lines.push(`book ${o.uuid} ${o.action} ${fmt(o.props.price, 6)} ${fmt(o.props.amount, 6)}`);
  fs.writeFileSync(process.argv[3], lines.join('\n') + '\n');
  const sorted = Array.from(lat).sort((x, y) => x - y);
  console.log(JSON.stringify({
    engine: 'legacy-js', node: process.version, orders: orders.length, trades: trades.length, errors,
    resting: ob.orders.length, wall_ms: +wallMs.toFixed(1), orders_per_sec: Math.round((orders.length - 1) / (wallMs / 1000)),
    p50_us: +pct(sorted, 0.5).toFixed(1), p99_us: +pct(sorted, 0.99).toFixed(1), max_us: +sorted[sorted.length - 1].toFixed(1),
    peak_rss_kb: vmHwmKb(),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
