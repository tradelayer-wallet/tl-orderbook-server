'use strict';
// Swap relay and terminal-step tests against fake sockets. No server, no native addon.
//
//   npm run build && node test/channel-swap.test.js

const { EventEmitter } = require('events');
const path = require('path');
const assert = require('assert');

const { ChannelSwap } = require(path.join(__dirname, '..', 'dist', 'services', 'channel-swap', 'channel-swap.class.js'));

class FakeSocket extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sent = [];
  }
  send(msg) { this.sent.push(JSON.parse(msg)); }
  // a message from the peer, as the uWebSockets layer delivers it
  deliver(obj) { this.emit('message', JSON.stringify(obj)); }
}

let n = 0;
function swapPair() {
  n += 1;
  const client = new FakeSocket(`c${n}`);
  const dealer = new FakeSocket(`d${n}`);
  const tradeInfo = {
    buyer: { uuid: `b${n}`, socketId: client.id },
    seller: { uuid: `s${n}`, socketId: dealer.id },
  };
  const swap = new ChannelSwap(client, dealer, tradeInfo, {});
  return { client, dealer, swap, done: swap.onReady() };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('BUYER:STEP6 from the buyer resolves with the txid and is still relayed', async () => {
  const { client, dealer, done } = swapPair();
  client.deliver({ event: `${client.id}::swap`, eventName: 'BUYER:STEP6', data: 'ab'.repeat(32) });
  assert.deepStrictEqual(await done, { data: { txid: 'ab'.repeat(32) } });
  const relayed = dealer.sent.find((m) => m.event === `${client.id}::swap`);
  assert.strictEqual(relayed.data.eventName, 'BUYER:STEP6');
  assert.strictEqual(relayed.data.data, 'ab'.repeat(32));
  // closed: the sockets no longer carry swap listeners
  assert.strictEqual(client.listenerCount('message'), 0);
  assert.strictEqual(dealer.listenerCount('message'), 0);
  assert.strictEqual(client.listenerCount('close'), 0);
});

test('TERMINATE_TRADE from the dealer resolves with the reason and the sender', async () => {
  const { client, dealer, done } = swapPair();
  dealer.deliver({ event: `${dealer.id}::swap`, eventName: 'TERMINATE_TRADE', data: 'Undefined Error' });
  assert.deepStrictEqual(await done, { error: 'Undefined Error', socketId: dealer.id });
  assert.ok(client.sent.some((m) => m.event === `${dealer.id}::swap` && m.data.eventName === 'TERMINATE_TRADE'));
});

test('intermediate steps relay without resolving; a repeated step is dropped', async () => {
  const { client, dealer, swap, done } = swapPair();
  let settled = false;
  done.then(() => { settled = true; });
  dealer.deliver({ event: `${dealer.id}::swap`, eventName: 'SELLER:STEP1', data: { pubkey: '02aa' } });
  dealer.deliver({ event: `${dealer.id}::swap`, eventName: 'SELLER:STEP1', data: { pubkey: '02aa' } });
  client.deliver({ event: `${client.id}::swap`, eventName: 'BUYER:STEP2', data: { psbt: 'cHNidP8' } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(settled, false);
  assert.strictEqual(client.sent.filter((m) => m.event === `${dealer.id}::swap`).length, 1);
  const toDealer = dealer.sent.filter((m) => m.event === `${client.id}::swap`);
  assert.strictEqual(toDealer.length, 1);
  assert.strictEqual(toDealer[0].data.data.tradeUUID, `b${n}-s${n}`);
  client.deliver({ event: `${client.id}::swap`, eventName: 'BUYER:STEP6', data: 'cd'.repeat(32) });
  assert.deepStrictEqual(await done, { data: { txid: 'cd'.repeat(32) } });
  // a step after the terminal one is not relayed
  const before = client.sent.length;
  dealer.deliver({ event: `${dealer.id}::swap`, eventName: 'SELLER:STEP7', data: {} });
  assert.strictEqual(client.sent.length, before);
  void swap;
});

test('a peer disconnect resolves with an error', async () => {
  const { client, done } = swapPair();
  client.emit('close');
  assert.deepStrictEqual(await done, { error: 'client disconnected' });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    // a swap that never resolves must fail, not let node exit with the promise pending
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 2 s')), 2000));
    try { await Promise.race([fn(), timeout]); console.log(`ok - ${name}`); }
    catch (e) { failed += 1; console.log(`not ok - ${name}\n  ${e.stack}`); }
  }
  console.log(failed ? `${failed} failed` : `${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
