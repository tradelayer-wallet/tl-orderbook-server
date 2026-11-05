'use strict';
// Login and enforcement tests. No dependencies.
//
//   npm run build && node test/auth.test.js
//
// Needs Linux x86_64 with node >= 22 (global WebSocket), because the native addon
// (rust/matcher-core/matcher_core.node) is a Linux build and signs the test logins
// (testSignBip322). Each group starts the built server (dist/index.js) on a random loopback port.

const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const addon = require(path.join(ROOT, 'rust', 'matcher-core', 'matcher_core.node'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- server process
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const servers = [];
async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      TL_OB_BIND: '127.0.0.1',
      TL_OB_WS_PORT: String(port),
      TL_OB_WSS_PORT: '0',
      TL_OB_CHALLENGES_PER_MIN: '10000',
      TL_OB_VERIFIES_PER_MIN: '10000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const srv = { port, proc, log: () => log, stop: () => { try { proc.kill('SIGKILL'); } catch {} } };
  servers.push(srv);
  const t0 = Date.now();
  while (!/\[WS\] listening/.test(log)) {
    if (proc.exitCode !== null) throw new Error('server exited early:\n' + log);
    if (Date.now() - t0 > 20000) throw new Error('server did not start:\n' + log);
    await sleep(50);
  }
  return srv;
}

// ---------------------------------------------------------------- http
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request(
      { hostname: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } : headers },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: j, raw: b }); });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let secretSeq = 0;
const newSecret = () => sha256hex('tl-ob-auth-test-' + process.pid + '-' + Date.now() + '-' + ++secretSeq);

function sign(secret, type, network, message) {
  return JSON.parse(addon.testSignBip322(secret, type, network, message));
}

/** challenge -> sign -> verify. Returns { address, token, expiresAt, secret, res }. */
async function login(port, { type = 'p2wpkh', network = 'ltc', secret = newSecret() } = {}) {
  const ch = (await req(port, 'GET', '/auth/challenge')).body;
  const s = sign(secret, type, network, ch.message);
  const res = await req(port, 'POST', '/auth/verify', { address: s.address, message: ch.message, signature: s.signature });
  assert.strictEqual(res.status, 200, 'login failed: ' + res.raw);
  return { address: s.address, token: res.body.sessionToken, expiresAt: res.body.expiresAt, secret, res };
}

// ---------------------------------------------------------------- websocket
function wsConnect(port, { headers, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, headers ? { headers } : undefined);
    const c = { ws, msgs: [], cursor: 0, waiters: [], closed: false, closeCode: null };
    const pump = () => {
      c.waiters = c.waiters.filter((w) => {
        for (let i = c.cursor; i < c.msgs.length; i++) {
          if (w.pred(c.msgs[i])) { c.cursor = i + 1; w.resolve(c.msgs[i]); clearTimeout(w.timer); return false; }
        }
        return true;
      });
    };
    ws.onmessage = (e) => { c.msgs.push(JSON.parse(e.data)); pump(); resolve(c); };
    ws.onclose = (e) => { c.closed = true; c.closeCode = e.code; resolve(c); };
    ws.onerror = () => {};
    setTimeout(() => reject(new Error('ws connect timeout')), 8000).unref();
    c.send = (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    /** next message (after the last one consumed) matching pred */
    c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
      const w = { pred, resolve: res, timer: setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); rej(new Error('timeout waiting for message; got ' + JSON.stringify(c.msgs.slice(c.cursor)).slice(0, 600))); }, ms) };
      c.waiters.push(w);
      pump();
    });
    /** assert that no message matching pred arrives within ms */
    c.none = async (pred, ms = 400) => {
      await sleep(ms);
      const hit = c.msgs.slice(c.cursor).find(pred);
      assert.ok(!hit, 'unexpected message ' + JSON.stringify(hit));
    };
    c.close = () => { try { ws.close(); } catch {} };
  });
}

const is = (event) => (m) => m.event === event;
const isErr = (m) => m.event === 'order:error';

async function wsLogin(port, opts) {
  const c = await wsConnect(port, opts && opts.ws);
  const l = await login(port, opts && opts.login);
  c.send({ event: 'auth', token: l.token });
  const ok = await c.wait(is('auth_ok'));
  return { c, l, ok };
}

let mkSeq = 0;
const newMarket = () => ({ q: 1000 + ++mkSeq + (process.pid % 500) * 10 });
const mkKey = (m) => `4-${m.q}`;
function orderMsg(m, uuid, side, price, address, extra = {}) {
  const buy = side === 'BUY';
  return {
    event: 'new-order', isLimitOrder: true, type: 'SPOT', network: 'LTCTEST', uuid, marketKey: mkKey(m),
    price, amount: 1, keypair: { address, pubkey: '02' + '11'.repeat(32) },
    props: { id_for_sale: buy ? 4 : m.q, id_desired: buy ? m.q : 4, price, amount: 1 },
    ...extra,
  };
}
const closeMsg = (m, uuid) => ({ event: 'close-order', network: 'LTCTEST', marketKey: mkKey(m), orderUUID: uuid });
const amendMsg = (m, uuid) => ({ event: 'amend-order', network: 'LTCTEST', marketKey: mkKey(m), orderUUID: uuid, newAmount: 2 });

async function bookLevels(c, m) {
  c.send({ event: 'update-orderbook', marketKey: mkKey(m), network: 'LTCTEST' });
  const d = await c.wait((x) => x.event === 'orderbook-data' && x.marketKey === mkKey(m));
  return { bids: d.orders.bids, asks: d.orders.asks };
}

// ---------------------------------------------------------------- tiny runner
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log('PASS', name); }
  catch (e) { results.push([name, false]); console.log('FAIL', name, '\n    ', (e && e.stack) || e); }
}

// ================================================================ tests
(async () => {
  // ---------------- main server: short challenge TTL, one bot key
  const BOT_KEY = 'bot-key-' + sha256hex('k').slice(0, 24);
  const srv = await startServer({
    TL_OB_CHALLENGE_TTL_MS: '1500',
    TL_OB_BOT_KEYS: [sha256hex('another-key'), 'not-a-hash', sha256hex(BOT_KEY)].join(','),
  });
  const P = srv.port;

  await test('GET /auth/challenge returns {nonce, message, expiresAt}', async () => {
    const r = await req(P, 'GET', '/auth/challenge');
    assert.strictEqual(r.status, 200);
    assert.match(r.body.nonce, /^[0-9a-f]{32}$/);
    assert.ok(r.body.message.includes('nonce=' + r.body.nonce));
    assert.ok(r.body.expiresAt > Date.now());
  });

  await test('challenge/verify with a valid signature yields a session token (every address type, Bitcoin and Litecoin)', async () => {
    for (const network of ['btc', 'tbtc', 'rbtc', 'ltc', 'tltc', 'rltc']) {
      for (const type of ['p2wpkh', 'p2sh-p2wpkh', 'p2tr', 'p2pkh']) {
        const l = await login(P, { type, network });
        assert.match(l.token, /^[0-9a-f]{64}$/, `${network} ${type}`);
        assert.strictEqual(l.res.body.token, l.token);
        assert.strictEqual(l.res.body.address, l.address);
        const st = await req(P, 'GET', '/auth/status', undefined, { authorization: 'Bearer ' + l.token });
        assert.deepStrictEqual([st.body.authenticated, st.body.address], [true, l.res.body.address]);
      }
    }
  });

  await test('forged signature is rejected with 401', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    const victim = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    const attacker = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    const r = await req(P, 'POST', '/auth/verify', { address: victim.address, message: ch.message, signature: attacker.signature });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.sessionToken, undefined);
  });

  await test('signature over a different message is rejected', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    const s = sign(newSecret(), 'p2wpkh', 'ltc', ch.message + 'x');
    const r = await req(P, 'POST', '/auth/verify', { address: s.address, message: ch.message, signature: s.signature });
    assert.strictEqual(r.status, 401);
  });

  await test('garbage, malformed and oversized verify requests are rejected without a session', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    assert.strictEqual((await req(P, 'POST', '/auth/verify', 'not json')).status, 400);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', {})).status, 400);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', { address: 1, message: ch.message, signature: 'x' })).status, 400);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', { address: 'tltc1qnope', message: ch.message, signature: '!!!' })).status, 401);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', { address: 'a', message: 'no nonce here', signature: 'x' })).status, 400);
    const big = await req(P, 'POST', '/auth/verify', { address: 'a', message: ch.message, signature: 'A'.repeat(100000) }).catch(() => ({ status: 0 }));
    assert.ok(big.status !== 200 && big.status !== 401, 'oversized body status ' + big.status);
  });

  await test('replayed nonce is rejected', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    const s = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    const body = { address: s.address, message: ch.message, signature: s.signature };
    assert.strictEqual((await req(P, 'POST', '/auth/verify', body)).status, 200);
    const again = await req(P, 'POST', '/auth/verify', body);
    assert.strictEqual(again.status, 400);
    assert.match(again.body.error, /used/);
  });

  await test('a challenge is burned by a failed attempt too', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    const good = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    const bad = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', { address: good.address, message: ch.message, signature: bad.signature })).status, 401);
    assert.strictEqual((await req(P, 'POST', '/auth/verify', { address: good.address, message: ch.message, signature: good.signature })).status, 400);
  });

  await test('expired challenge is rejected', async () => {
    const ch = (await req(P, 'GET', '/auth/challenge')).body;
    const s = sign(newSecret(), 'p2wpkh', 'ltc', ch.message);
    await sleep(1800);
    const r = await req(P, 'POST', '/auth/verify', { address: s.address, message: ch.message, signature: s.signature });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /expired/);
  });

  await test('logout revokes the session', async () => {
    const { c, l } = await (async () => { const l = await login(P); const c = await wsConnect(P); return { c, l }; })();
    const out = await req(P, 'POST', '/auth/logout', { token: l.token });
    assert.strictEqual(out.body.revoked, true);
    c.send({ event: 'auth', token: l.token });
    const e = await c.wait(isErr);
    assert.match(e.message, /Invalid or expired/);
    c.close();
  });

  await test('unauthenticated socket cannot place, amend or close orders', async () => {
    const c = await wsConnect(P);
    assert.strictEqual(c.msgs[0].event, 'connected');
    assert.strictEqual(c.msgs[0].clientClass, 'web');
    assert.strictEqual(c.msgs[0].authRequired, true);
    const m = newMarket();
    for (const msg of [orderMsg(m, 'u-anon', 'BUY', 1000, 'ltc1qanything'), amendMsg(m, 'u-anon'), closeMsg(m, 'u-anon'), { event: 'many-orders', marketKey: mkKey(m), network: 'LTCTEST', orders: [orderMsg(m, 'u-anon2', 'BUY', 1000, 'x')] }]) {
      c.send(msg);
      const e = await c.wait(isErr);
      assert.match(e.message, /Authentication required/, msg.event);
    }
    await c.none(is('order:saved'));
    c.close();
  });

  await test('WS auth then new-order is accepted; auth_ok carries address and expiry', async () => {
    const { c, l, ok } = await wsLogin(P);
    assert.strictEqual(ok.address, l.res.body.address);
    assert.strictEqual(ok.expiresAt, l.expiresAt);
    const m = newMarket();
    c.send(orderMsg(m, 'u-ok-1', 'BUY', 1000, l.address));
    const saved = await c.wait(is('order:saved'));
    assert.strictEqual(saved.orderUuid, 'u-ok-1');
    const placed = await c.wait(is('placed-orders'));
    assert.deepStrictEqual(placed.openedOrders.map((o) => o.uuid), ['u-ok-1']);
    c.close();
  });

  await test('order for an address this socket has not authenticated is rejected', async () => {
    const { c, l } = await wsLogin(P);
    const other = await login(P); // a real login, but on a different socket
    const m = newMarket();
    c.send(orderMsg(m, 'u-foreign', 'BUY', 1000, other.address));
    const e = await c.wait(isErr);
    assert.match(e.message, /not authenticated/);
    c.send(orderMsg(m, 'u-nokp', 'BUY', 1000, undefined));
    assert.match((await c.wait(isErr)).message, /keypair\.address is required/);
    c.send({ ...orderMsg(m, 'u-nokp2', 'BUY', 1000, l.address), keypair: undefined });
    assert.match((await c.wait(isErr)).message, /keypair\.address is required/);
    await c.none(is('order:saved'));
    c.close();
  });

  await test('many-orders is all-or-nothing on address binding', async () => {
    const { c, l } = await wsLogin(P);
    const other = await login(P);
    const m = newMarket();
    c.send({ event: 'many-orders', marketKey: mkKey(m), network: 'LTCTEST', orders: [orderMsg(m, 'mo-1', 'BUY', 1000, l.address), orderMsg(m, 'mo-2', 'BUY', 999, other.address)] });
    assert.match((await c.wait(isErr)).message, /not authenticated/);
    await c.none(is('order:saved'));
    c.send({ event: 'many-orders', marketKey: mkKey(m), network: 'LTCTEST', orders: [orderMsg(m, 'mo-1', 'BUY', 1000, l.address), orderMsg(m, 'mo-2', 'BUY', 999, l.address)] });
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'mo-1');
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'mo-2');
    c.close();
  });

  await test('a socket may authenticate several addresses and trade for each', async () => {
    const { c, l } = await wsLogin(P);
    const b = await login(P);
    c.send({ event: 'auth', token: b.token });
    const ok2 = await c.wait(is('auth_ok'));
    assert.strictEqual(ok2.address, b.res.body.address);
    const m = newMarket();
    c.send(orderMsg(m, 'multi-a', 'BUY', 1000, l.address));
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'multi-a');
    c.send(orderMsg(m, 'multi-b', 'SELL', 2000, b.address));
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'multi-b');
    // and the owner of each may close it from this socket
    c.send(closeMsg(m, 'multi-a'));
    await c.wait(is('placed-orders'));
    c.close();
  });

  await test('close and amend are limited to the stored order owner; uuid cannot be taken over', async () => {
    const owner = await wsLogin(P);
    const thief = await wsLogin(P);
    const m = newMarket();
    owner.c.send({ event: 'orderbook:join', marketKey: mkKey(m), network: 'LTCTEST' });
    thief.c.send({ event: 'orderbook:join', marketKey: mkKey(m), network: 'LTCTEST' });
    owner.c.send(orderMsg(m, 'own-1', 'BUY', 1000, owner.l.address));
    await owner.c.wait(is('order:saved'));
    await owner.c.wait(is('placed-orders'));

    thief.c.send(closeMsg(m, 'own-1'));
    assert.match((await thief.c.wait(isErr)).message, /not authenticated|Unknown/);
    thief.c.send(amendMsg(m, 'own-1'));
    assert.match((await thief.c.wait(isErr)).message, /not authenticated|Unknown/);
    thief.c.send(orderMsg(m, 'own-1', 'SELL', 2000, thief.l.address));
    assert.match((await thief.c.wait(isErr)).message, /already in use/);

    // the order still rests
    const lv = await bookLevels(thief.c, m);
    assert.strictEqual(lv.bids.length, 1, JSON.stringify(lv));

    owner.c.send(closeMsg(m, 'own-1'));
    const placed = await owner.c.wait(is('placed-orders'));
    assert.strictEqual(placed.openedOrders.length, 0);
    const lv2 = await bookLevels(thief.c, m);
    assert.strictEqual(lv2.bids.length, 0, JSON.stringify(lv2));
    owner.c.close(); thief.c.close();
  });

  await test('header x-tradelayer-client: desktop no longer exempts a socket', async () => {
    const c = await wsConnect(P, { headers: { 'x-tradelayer-client': 'desktop' } });
    assert.strictEqual(c.msgs[0].event, 'connected');
    assert.strictEqual(c.msgs[0].clientClass, 'web');
    assert.strictEqual(c.msgs[0].authRequired, true);
    const m = newMarket();
    c.send(orderMsg(m, 'desk-1', 'BUY', 1000, 'ltc1qwhatever'));
    assert.match((await c.wait(isErr)).message, /Authentication required/);
    c.close();
  });

  await test('bot key: right key (header or query) is a bot; wrong key is refused; no key is web', async () => {
    const bot = await wsConnect(P, { headers: { 'x-tl-api-key': BOT_KEY } });
    assert.strictEqual(bot.msgs[0].clientClass, 'bot');
    assert.strictEqual(bot.msgs[0].authRequired, false);
    const m = newMarket();
    bot.send(orderMsg(m, 'bot-1', 'BUY', 1000, 'ltc1qbotaddress'));
    await bot.wait((x) => x.event === 'order:saved' && x.orderUuid === 'bot-1');
    // a bot may close its own order
    bot.send(closeMsg(m, 'bot-1'));
    await bot.wait(is('placed-orders'));
    bot.close();

    const botQ = await wsConnect(P, { query: '?apiKey=' + encodeURIComponent(BOT_KEY) });
    assert.strictEqual(botQ.msgs[0].clientClass, 'bot');
    botQ.close();

    for (const wrong of [BOT_KEY + 'x', BOT_KEY.slice(0, -1), sha256hex(BOT_KEY), 'another-key2', 'not-a-hash', 'x']) {
      const w = await wsConnect(P, { headers: { 'x-tl-api-key': wrong } });
      assert.strictEqual(w.msgs[0].event, 'order:error', 'wrong key ' + wrong);
      assert.match(w.msgs[0].message, /Invalid API key/);
      await sleep(150);
      assert.ok(w.closed, 'socket with wrong key stays open');
    }

    const web = await wsConnect(P);
    assert.strictEqual(web.msgs[0].clientClass, 'web');
    web.send(orderMsg(m, 'bot-2', 'BUY', 1000, 'ltc1qbotaddress'));
    assert.match((await web.wait(isErr)).message, /Authentication required/);
    web.close();
  });

  await test('a web client cannot take over a bot order uuid, and a bot cannot be impersonated via session auth', async () => {
    const bot = await wsConnect(P, { headers: { 'x-tl-api-key': BOT_KEY } });
    const web = await wsLogin(P);
    const m = newMarket();
    bot.send(orderMsg(m, 'bot-held', 'BUY', 1000, 'ltc1qbotaddress'));
    await bot.wait(is('order:saved'));
    web.c.send(closeMsg(m, 'bot-held'));
    assert.match((await web.c.wait(isErr)).message, /not authenticated|Unknown/);
    web.c.send(orderMsg(m, 'bot-held', 'SELL', 2000, web.l.address));
    assert.match((await web.c.wait(isErr)).message, /already in use/);
    bot.send({ event: 'auth', token: web.l.token });
    assert.strictEqual((await bot.wait(is('auth_ignored'))).event, 'auth_ignored');
    bot.close(); web.c.close();
  });

  await test('non-object and malformed frames do not crash the server', async () => {
    const c = await wsConnect(P);
    for (const frame of ['null', '[1,2]', '7', '"x"', '{', '{"event":null}', '{"event":"auth","token":{"a":1}}']) c.send(frame);
    await sleep(300);
    const r = await req(P, 'GET', '/auth/challenge');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(srv.proc.exitCode, null, srv.log());
    c.close();
  });

  // ---------------- short sessions: expiry drops the address, re-auth extends
  await test('expired session drops its address; re-auth with a fresh token extends', async () => {
    const s = await startServer({ TL_OB_SESSION_TTL_MS: '1500' });
    const c = await wsConnect(s.port);
    const l1 = await login(s.port);
    c.send({ event: 'auth', token: l1.token });
    const a1 = await c.wait(is('auth_ok'));
    const m = newMarket();
    c.send(orderMsg(m, 'exp-1', 'BUY', 1000, l1.address));
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'exp-1');

    await sleep(900);
    // same address, fresh session before expiry: extends
    const l2 = await login(s.port, { secret: l1.secret });
    assert.strictEqual(l2.address, l1.address);
    c.send({ event: 'auth', token: l2.token });
    const a2 = await c.wait(is('auth_ok'));
    assert.ok(a2.expiresAt > a1.expiresAt, 'auth_ok expiresAt did not move forward');
    await sleep(900); // now past the first session's expiry, inside the second's
    c.send(orderMsg(m, 'exp-2', 'BUY', 999, l1.address));
    await c.wait((x) => x.event === 'order:saved' && x.orderUuid === 'exp-2');
    // the extended session also keeps the owner rights over the first order
    c.send(closeMsg(m, 'exp-1'));
    await c.wait(is('placed-orders'));

    await sleep(1400); // past the second session's expiry
    c.send(orderMsg(m, 'exp-3', 'BUY', 998, l1.address));
    assert.match((await c.wait(isErr)).message, /Authentication required|not authenticated/);
    c.send(closeMsg(m, 'exp-2'));
    assert.match((await c.wait(isErr)).message, /Authentication required|not authenticated/);
    // a fresh login restores access, to the still-resting order too
    const l3 = await login(s.port, { secret: l1.secret });
    c.send({ event: 'auth', token: l3.token });
    await c.wait(is('auth_ok'));
    c.send(closeMsg(m, 'exp-2'));
    await c.wait(is('placed-orders'));
    c.close(); s.stop();
  });

  // ---------------- limits
  await test('challenge issuance is rate limited per IP', async () => {
    const s = await startServer({ TL_OB_CHALLENGES_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) assert.strictEqual((await req(s.port, 'GET', '/auth/challenge')).status, 200);
    const r = await req(s.port, 'GET', '/auth/challenge');
    assert.strictEqual(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) >= 1);
    s.stop();
  });

  await test('pending challenges are bounded', async () => {
    const s = await startServer({ TL_OB_MAX_CHALLENGES: '5' });
    for (let i = 0; i < 5; i++) assert.strictEqual((await req(s.port, 'GET', '/auth/challenge')).status, 200);
    assert.strictEqual((await req(s.port, 'GET', '/auth/challenge')).status, 503);
    s.stop();
  });

  await test('verify attempts are rate limited per IP', async () => {
    const s = await startServer({ TL_OB_VERIFIES_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) assert.strictEqual((await req(s.port, 'POST', '/auth/verify', {})).status, 400);
    assert.strictEqual((await req(s.port, 'POST', '/auth/verify', {})).status, 429);
    s.stop();
  });

  // ---------------- done
  srv.stop();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  servers.forEach((s) => s.stop());
  process.exit(1);
});

process.on('exit', () => servers.forEach((s) => s.stop()));
