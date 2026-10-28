'use strict';

/*
 * Round 6 — regressions found in the 1412b5a..2d2612f review.
 *
 * Each scenario is written to FAIL on the pre-round-6 behaviour and PASS once fixed.
 *
 *  a) a client cancel (close-order) of an order that an in-flight swap has locked is
 *     refused with an explicit error; the order stays on the book, and the swap can
 *     still settle with the order intact.
 *  b) a BUYER:STEP6 txid in upper case is accepted, but it is recorded and relayed in
 *     one canonical (lowercase) form.
 *  c) a swap sessionId that is not exactly 64 lowercase hex characters is refused
 *     before any session lookup, with a shape error.
 *  d) the server never writes the order's keypair address or pubkey to the console.
 *  e) a many-orders batch whose entry crosses the book under noTrades is refused with
 *     an explicit error and leaves no half-applied state: no swap is started, the
 *     counterparty's order stays unlocked, and only the entries placed are resting.
 */
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, ordersOf, allHistory, activeSwapSessions,
    sessionOf, waitForEvent, txidOf, txidFor, negotiate,
} = require('./common');

// R6_ONLY=a,c runs only those scenarios (used to show each one fails on old code).
const run = (k) => !process.env.R6_ONLY || process.env.R6_ONLY.split(',').includes(k);

// Opens a swap in which `maker` rests a SELL and `taker` buys it. Returns the taker's
// session id and the maker's resting order uuid.
const openSwap = async (url, tag, price = 1) => {
    const M = await connectClient(url, `${tag}-maker`);
    const T = await connectClient(url, `${tag}-taker`);
    M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price }));
    await waitFor(() => ordersOf(M.id).length === 1, { message: `${tag}: maker order rested` });
    const uuid = ordersOf(M.id)[0].uuid;
    const before = activeSwapSessions();
    T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: price + 2, id_for_sale: 1, id_desired: 2 }));
    await waitFor(() => activeSwapSessions() === before + 1, { message: `${tag}: swap started` });
    await waitForEvent(T, 'new-channel', () => true, { message: `${tag}: taker new-channel` });
    return { M, T, sid: sessionOf(T), uuid };
};

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- a) cancel of a swap-locked order ------------------------------
        if (run('a')) {
            const { M, T, sid, uuid } = await openSwap(url, 'r6a');
            const txid = txidFor(sid);
            const placedBefore = eventsOf(M, 'placed-orders').length;
            M.socket.emit('close-order', uuid);
            await waitFor(() => M.errors.length > 0 || eventsOf(M, 'placed-orders').length > placedBefore,
                { message: 'r6a: maker close-order answered' });
            assert.ok(/locked/i.test(String(M.errors[M.errors.length - 1])),
                `R6a FAIL: cancel of a swap-locked order was not refused (got "${M.errors[M.errors.length - 1]}")`);
            assert.strictEqual(ordersOf(M.id).length, 1,
                'R6a FAIL: swap-locked order was removed by a client cancel');

            await negotiate(sid, T, M);
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', data: txid });
            await waitFor(() => allHistory().some((h) => h.txid === txid), { message: 'r6a: trade settled' });
            assert.strictEqual(ordersOf(M.id).length, 0, 'R6a: settled maker order should be gone');
            console.log('R6a PASS: swap-locked order cannot be cancelled by its owner; swap settles intact');
            M.socket.close(); T.socket.close();
        }

        // ---- b) txid canonical lowercase ------------------------------------
        if (run('b')) {
            const { M, T, sid } = await openSwap(url, 'r6b', 2);
            const txid = txidFor(sid);
            await negotiate(sid, T, M);
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', data: txid.toUpperCase() });
            await waitFor(() => T.errors.length > 0, { message: 'r6b: upper-case txid answered' });
            assert.match(String(T.errors[T.errors.length - 1]), /BUYER:STEP6 data does not match its schema/,
                'R6b FAIL: an upper-case txid was not refused by the schema');
            await sleep(100);
            assert.ok(!allHistory().some((h) => h.txid === txid || h.txid === txid.toUpperCase()), 'R6b FAIL: upper-case txid stored in history');
            assert.ok(!eventsOf(M, 'swap').some((e) => e.args[0].eventName === 'BUYER:STEP6'), 'R6b FAIL: upper-case txid relayed');
            T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', data: txid });
            await waitFor(() => allHistory().some((h) => h.txid === txid), { message: 'r6b: lowercase txid recorded' });
            console.log('R6b PASS: an upper-case txid is refused by the schema; the lowercase form is recorded and relayed');
            M.socket.close(); T.socket.close();
        }

        // ---- c) sessionId shape enforced before lookup ----------------------
        if (run('c')) {
            const X = await connectClient(url, 'r6c');
            X.socket.emit('swap', { sessionId: 'x'.repeat(100000), eventName: 'BUYER:STEP6', data: 'ab'.repeat(32) });
            await waitFor(() => X.errors.length > 0, { message: 'r6c: swap error received' });
            const msg = String(X.errors[X.errors.length - 1]);
            assert.ok(/sessionId \(64 lowercase hex/.test(msg), `R6c FAIL: oversized sessionId not refused by shape (got "${msg}")`);
            X.socket.emit('swap', { sessionId: 'AB'.repeat(32), eventName: 'BUYER:STEP6', data: 'ab'.repeat(32) });
            await waitFor(() => X.errors.length > 1, { message: 'r6c: second swap error received' });
            assert.ok(/sessionId \(64 lowercase hex/.test(String(X.errors[X.errors.length - 1])),
                'R6c FAIL: upper-case sessionId not refused by shape');
            console.log('R6c PASS: malformed sessionId refused by shape before any lookup');
            X.socket.close();
        }

        // ---- d) no keypair material on the console ---------------------------
        if (run('d')) {
            const captured = [];
            const realLog = console.log;
            console.log = (...args) => { captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
            let D;
            try {
                D = await connectClient(url, 'r6d');
                const before = ordersOf(D.id).length;
                D.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 50, id_for_sale: 7, id_desired: 8, keypair: { address: 'SECRETADDR-r6d', pubkey: 'SECRETPUB-r6d' } }));
                await waitFor(() => ordersOf(D.id).length === before + 1, { message: 'r6d: order rested' });
                const uuid = ordersOf(D.id)[0].uuid;
                D.socket.emit('close-order', uuid);
                await waitFor(() => ordersOf(D.id).length === before, { message: 'r6d: order cancelled' });
            } finally {
                console.log = realLog;
            }
            const leaked = captured.filter((l) => /SECRETADDR-r6d|SECRETPUB-r6d/.test(l));
            assert.strictEqual(leaked.length, 0, `R6d FAIL: keypair written to console (${leaked.length} line(s))`);
            console.log('R6d PASS: order placement and cancel do not log keypair material');
            D.socket.close();
        }

        // ---- e) refused many-orders entry leaves no half-applied state -------
        if (run('e')) {
            const Y = await connectClient(url, 'r6e-maker');
            const X = await connectClient(url, 'r6e-batch');
            Y.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, id_for_sale: 3, id_desired: 4 }));
            await waitFor(() => ordersOf(Y.id).length === 1, { message: 'r6e: maker rested' });
            const yUuid = ordersOf(Y.id)[0].uuid;
            const sessionsBefore = activeSwapSessions();
            const errorsBefore = X.errors.length;
            X.socket.emit('many-orders', [
                rawSpotOrder({ action: 'BUY', amount: 1, price: 5, id_for_sale: 4, id_desired: 3 }), // crosses Y: refused
                rawSpotOrder({ action: 'SELL', amount: 1, price: 9, id_for_sale: 3, id_desired: 4 }), // rests
            ]);
            await waitForEvent(X, 'order:saved', () => true, { message: 'r6e: batch saved' });
            await waitFor(() => X.errors.length > errorsBefore, { message: 'r6e: refusal reported' });
            assert.ok(/trades are disabled/.test(String(X.errors[X.errors.length - 1])),
                `R6e FAIL: crossing entry not reported (got "${X.errors[X.errors.length - 1]}")`);
            assert.strictEqual(activeSwapSessions(), sessionsBefore, 'R6e FAIL: refused entry started a swap');
            assert.strictEqual(ordersOf(X.id).length, 1, 'R6e FAIL: book does not match the placed entries');
            const y = ordersOf(Y.id).find((o) => o.uuid === yUuid);
            assert.ok(y && !y.lock, 'R6e FAIL: counterparty order was locked by a refused entry');
            console.log('R6e PASS: refused many-orders entry reported; no swap, no lock, book matches placed entries');
            Y.socket.close(); X.socket.close();
        }

        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error('R6 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
