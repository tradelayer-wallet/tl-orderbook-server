'use strict';

/*
 * Round 3 — swap relay, settlement input, and many-orders result handling.
 *
 * Each scenario is a regression for a defect found in the f7f1b28..HEAD diff
 * review. Each is written to FAIL on the pre-round-3 behaviour and PASS once fixed.
 *
 *  a) relay stamps the sender: the counterparty receives `socketId` = the real
 *     emitting socket, and only the envelope fields (no client-added keys).
 *  b) BUYER:STEP6 is only accepted with a 64-hex txid. Junk or missing data does
 *     not settle the swap, is not relayed, and does not reach the trade history.
 *  c) a TERMINATE_TRADE reason is bounded before it reaches the other party's
 *     order:error.
 *  d) a many-orders entry that cannot be placed (crosses the book under noTrades)
 *     is reported with an explicit error, not silently discarded.
 *  e) a maker that terminates a swap keeps its order, unlocked, with no CANCALED entry;
 *     its close-order then removes it and records CANCALED. (Terminating used to remove
 *     the order, which let a taker delete any order its swap made the maker's wallet refuse.)
 *  f) a swap event with a non-string eventName is rejected, not relayed.
 */
const fs = require('fs');
const path = require('path');
const {
    assert, waitFor, sleep, startServer, stopServer, connectClient,
    eventsOf, waitForEvent, rawSpotOrder, ordersOf, allHistory,
    activeSwapSessions, sessionOf, emitSwap, workDir, openSocket, negotiate, MS_DATA, txidFor,
} = require('./common');

// R3_ONLY=b,d runs only those scenarios (used to show each one fails on old code).
const run = (k) => !process.env.R3_ONLY || process.env.R3_ONLY.split(',').includes(k);

const orderLogEntries = (uuid) => {
    const dir = path.join(workDir, 'logs');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('ORDER')) continue;
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            if (!line) continue;
            const o = JSON.parse(line);
            if (o.uuid === uuid) out.push({ file: f, state: o.state || null });
        }
    }
    return out;
};

// Maker rests a SELL at price 1; taker places a crossing BUY at price 1.
// Returns once both sides have received new-channel for the new session.
const openSwap = async (url, tag) => {
    const M = await connectClient(url, `${tag}-maker`);
    const T = await connectClient(url, `${tag}-taker`);
    M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1 }));
    await waitFor(() => ordersOf(M.id).length === 1, { message: `${tag}: maker order rested` });
    const before = activeSwapSessions();
    T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2 }));
    await waitForEvent(M, 'new-channel', () => true, { message: `${tag}: maker new-channel` });
    await waitForEvent(T, 'new-channel', () => true, { message: `${tag}: taker new-channel` });
    await waitFor(() => activeSwapSessions() === before + 1, { message: `${tag}: session registered` });
    return { M, T, sid: sessionOf(T) };
};

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- a) relay stamps the sender -----------------------------------
        if (run('a')) {
            const { M, T, sid } = await openSwap(url, 'a');
            M.socket.emit('swap', { sessionId: sid, eventName: 'SELLER:STEP1', socketId: 'forged-socket-id', data: MS_DATA, extra: 'smuggled' });
            const ev = (await waitForEvent(T, 'swap', (e) => e.eventName === 'SELLER:STEP1', { message: 'a: SELLER:STEP1 relayed' })).args[0];
            assert.strictEqual(ev.socketId, M.id,
                `R3a FAIL: counterparty saw client-chosen socketId ${ev.socketId}, expected sender ${M.id}`);
            assert.deepStrictEqual(Object.keys(ev).sort(), ['data', 'eventName', 'sessionId', 'socketId'],
                `R3a FAIL: relay carried client-added fields: ${Object.keys(ev).join(',')}`);
            console.log('R3a PASS: relay stamps socketId server-side and drops client-added fields');
            T.socket.emit('swap', { sessionId: sid, eventName: 'TERMINATE_TRADE', socketId: T.id, data: 'cleanup' });
            M.socket.close();
            T.socket.close();
        }

        // ---- b) BUYER:STEP6 txid must be well-formed --------------------------
        if (run('b')) {
            const { M, T, sid } = await openSwap(url, 'b');
            await negotiate(sid, T, M);
            const openNow = activeSwapSessions();
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', socketId: T.id, data: 'x'.repeat(4000) });
            await sleep(200);
            assert.strictEqual(activeSwapSessions(), openNow,
                'R3b FAIL: a non-txid BUYER:STEP6 settled the swap');
            assert.ok(!eventsOf(M, 'swap').some((e) => e.args[0].eventName === 'BUYER:STEP6'),
                'R3b FAIL: a non-txid BUYER:STEP6 was relayed to the seller');
            assert.ok(!allHistory().some((h) => h.txid && h.txid.length > 200),
                'R3b FAIL: oversized txid was written to the trade history');
            assert.ok(T.errors.length > 0, 'R3b FAIL: junk txid got no error back to the buyer');

            // A missing txid must not settle either.
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', socketId: T.id });
            await sleep(100);
            assert.strictEqual(activeSwapSessions(), openNow,
                'R3b FAIL: a BUYER:STEP6 with no txid settled the swap');

            // A well-formed txid settles, and that txid is what gets recorded.
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', socketId: T.id, data: txidFor(sid) });
            await waitFor(() => activeSwapSessions() === openNow - 1, { message: 'b: valid txid settles' });
            await waitFor(() => allHistory().some((h) => h.txid === txidFor(sid)), { message: 'b: txid recorded' });
            console.log('R3b PASS: junk or missing BUYER:STEP6 data neither settles nor reaches history');
            M.socket.close(); T.socket.close();
        }

        // ---- c) TERMINATE_TRADE reason is bounded -----------------------------
        if (run('c')) {
            const { M, T, sid } = await openSwap(url, 'c');
            M.socket.emit('swap', { sessionId: sid, eventName: 'TERMINATE_TRADE', socketId: M.id, data: 'r'.repeat(5000) });
            await waitFor(() => M.errors.length > 0, { message: 'c: over-long reason refused' });
            assert.match(M.errors[M.errors.length - 1], /data does not match its schema/, 'R3c FAIL: over-long reason not refused by schema');
            await sleep(100);
            assert.strictEqual(T.errors.length, 0, 'R3c FAIL: a refused termination reached the counterparty');
            assert.strictEqual(activeSwapSessions(), 1, 'R3c FAIL: a refused termination ended the session');
            M.socket.emit('swap', { sessionId: sid, eventName: 'TERMINATE_TRADE', socketId: M.id, data: 'r'.repeat(256) });
            await waitFor(() => T.errors.length > 0, { message: 'c: taker sees the termination' });
            const msg = T.errors[T.errors.length - 1];
            assert.ok(msg.length <= 256,
                `R3c FAIL: counterparty order:error carried a ${msg.length}-char reason`);
            console.log(`R3c PASS: over-long termination reason refused; a 256-char reason is delivered (${msg.length} chars)`);
            M.socket.close(); T.socket.close();
        }

        // ---- d) many-orders reports an unplaceable order -----------------------
        if (run('d')) {
            const M = await connectClient(url, 'd-maker');
            const T = await connectClient(url, 'd-taker');
            M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1 }));
            await waitFor(() => ordersOf(M.id).length === 1, { message: 'd: maker order rested' });
            const sessionsBefore = activeSwapSessions();
            const errorsBefore = T.errors.length;
            T.socket.emit('many-orders', [rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2 })]);
            await waitFor(() => eventsOf(T, 'order:saved').length > 0 || T.errors.length > errorsBefore,
                { message: 'd: many-orders answered' });
            await sleep(100);
            assert.ok(T.errors.length > errorsBefore,
                'R3d FAIL: a crossing many-orders entry was discarded without any error');
            assert.strictEqual(ordersOf(T.id).length, 0, 'R3d FAIL: crossing batch order rested on the book');
            assert.strictEqual(activeSwapSessions(), sessionsBefore, 'R3d FAIL: crossing batch order started a swap');
            console.log(`R3d PASS: crossing batch order reported (${T.errors[T.errors.length - 1]})`);
            M.socket.close(); T.socket.close();
        }

        // ---- e) maker-side termination unlocks; close-order audits CANCALED -----
        if (run('e')) {
            const { M, T, sid } = await openSwap(url, 'e');
            const uuid = ordersOf(M.id)[0].uuid;
            M.socket.emit('swap', { sessionId: sid, eventName: 'TERMINATE_TRADE', socketId: M.id, data: 'owner abort' });
            await waitFor(() => ordersOf(M.id).some((o) => o.uuid === uuid && o.lock === false),
                { message: 'e: maker order unlocked' });
            await sleep(200);
            assert.ok(!orderLogEntries(uuid).some((x) => x.state === 'CANCALED'),
                'R3e FAIL: a terminated swap recorded its maker order as CANCALED');
            M.socket.emit('close-order', uuid);
            await waitFor(() => ordersOf(M.id).length === 0, { message: 'e: owner close-order removes the order' });
            await waitFor(() => orderLogEntries(uuid).some((x) => x.state === 'CANCALED'),
                { message: 'e: CANCALED written by close-order' });
            console.log('R3e PASS: maker-terminated order stays unlocked; its close-order removes it and audits CANCALED');
            M.socket.close(); T.socket.close();
        }

        // ---- f) non-string eventName is rejected ------------------------------
        if (run('f')) {
            const { M, T, sid } = await openSwap(url, 'f');
            const beforeRelay = eventsOf(M, 'swap').length;
            T.socket.emit('swap', { sessionId: sid, eventName: { toString: 1 }, socketId: T.id, data: 'x' });
            await waitFor(() => T.errors.length > 0, { message: 'f: malformed event answered' });
            await sleep(100);
            assert.strictEqual(eventsOf(M, 'swap').length, beforeRelay,
                'R3f FAIL: a swap event with a non-string eventName was relayed');
            console.log('R3f PASS: swap event with a non-string eventName is rejected, not relayed');
            M.socket.close(); T.socket.close();
        }

        // ---- g) WebSocket handshake honours the CORS origin decision ----------
        if (run('g')) {
            const handshake = (origin) => new Promise((resolve) => {
                const headers = origin === undefined ? {} : { Origin: origin };
                const s = openSocket(url, { headers, timeout: 3000 });
                s.on('connect', () => { s.close(); resolve(true); });
                s.on('connect_error', () => { s.close(); resolve(false); });
            });
            assert.strictEqual(await handshake('https://evil.example'), false,
                'R3g FAIL: WebSocket handshake from a non-allowlisted origin was accepted');
            assert.strictEqual(await handshake('https://layerwallet.com'), true,
                'R3g FAIL: allowlisted origin was refused on WebSocket');
            assert.strictEqual(await handshake('null'), true,
                'R3g FAIL: file:// (Origin: null) was refused on WebSocket');
            assert.strictEqual(await handshake(undefined), true,
                'R3g FAIL: non-browser handshake without Origin was refused');
            console.log('R3g PASS: WebSocket handshake gated by the CORS origin decision; non-browser clients unaffected');
        }

        await stopServer(server);
        console.log('R3 (round-3 swap hardening): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('R3 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
