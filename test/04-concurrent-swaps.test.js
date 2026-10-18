'use strict';

/*
 * T4 — Concurrent swap sessions on shared sockets must not clobber each other.
 *
 * Proven bug (pre-fix): `removePreviuesEventListeners` called
 * removeAllListeners('<id>::swap') on session start AND settle, wiping other
 * in-flight swap sessions on the same socket. Repro: trade1 (A<->B) settles
 * normally -> trade2's (A<->C) relay/inspection listeners are wiped -> the
 * second trade hits a spurious 120s (SWAP_TIMEOUT_MS) timeout.
 *
 * Expected (post-fix): session-scoped listener removal only.
 *  - trade2's relay stays alive while trade1 starts and settles
 *  - both trades settle with their own txids, well within the swap timeout
 *  - no leftover ::swap listeners on any socket afterwards
 *
 * Setup (shared socket A):
 *   trade1: B rests SELL@2 -> A takes BUY@2   (buyer A, seller B)
 *   trade2: A rests SELL@1 -> C takes BUY@1   (buyer C, seller A)
 */
// Generous swap timeout: a spurious timeout shows up as "did not settle within
// 3s", well below this. Must be set before ./common loads the config module.
process.env.SWAP_TIMEOUT_MS = '30000';

const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, emitSwap, sessionOf, ordersOf, allHistory, activeSwapSessions, negotiate,
} = require('./common');

const { txidFor } = require('./common');

(async () => {
    // Generous swap timeout: a spurious timeout shows up as "did not settle
    // within 3s", well below this.
    const { server, url } = await startServer();
    try {
        const A = await connectClient(url, 'A');
        const B = await connectClient(url, 'B');
        const C = await connectClient(url, 'C');

        // ---- trade1: B rests SELL@2, A takes BUY@2 -------------------------
        B.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 2, id_for_sale: 2, id_desired: 1, keypair: { address: 'addr-b', pubkey: 'pk-b' } }));
        await waitFor(() => ordersOf(B.id).length === 1, { message: 'B order on book' });
        const bOrder = ordersOf(B.id)[0];

        A.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 2, id_for_sale: 1, id_desired: 2, keypair: { address: 'addr-a', pubkey: 'pk-a' } }));
        await waitFor(() => eventsOf(A, 'new-channel').length === 1 && eventsOf(B, 'new-channel').length === 1,
            { message: 'trade1 channel opened' });

        // ---- trade2 opens while trade1 is still in flight: A rests SELL@1 --
        A.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, id_for_sale: 2, id_desired: 1, keypair: { address: 'addr-a2', pubkey: 'pk-a2' } }));
        await waitFor(() => ordersOf(A.id).length === 1, { message: 'A second order rested' });
        const aOrder = ordersOf(A.id)[0];

        C.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2, keypair: { address: 'addr-c', pubkey: 'pk-c' } }));
        await waitFor(() => eventsOf(C, 'new-channel').length === 1 && eventsOf(A, 'new-channel').length === 2,
            { message: 'trade2 channel opened' });

        // ---- the proven symptom: trade1's relay must survive trade2's start
        // Trade1 is negotiated in full (A buys from B) after trade2 opened: every relay must arrive.
        const sid1 = sessionOf(A, 0);
        await negotiate(sid1, A, B);
        console.log('T4a PASS: trade1 relays (both directions) alive after trade2 opened (pre-fix: wiped)');

        // ---- trade1 completes with its own txid ---------------------------
        emitSwap(A, sid1, 'BUYER:STEP6', txidFor(sid1));
        await waitFor(() => allHistory().some((h) => h.txid === txidFor(sid1)), { timeout: 3000, message: 'trade1 settled' });

        // ---- trade2 still settles normally, with its own txid -------------
        await negotiate(sessionOf(C, 0), C, A);
        emitSwap(C, sessionOf(C, 0), 'BUYER:STEP6', txidFor(sessionOf(C, 0)));
        await waitFor(() => allHistory().some((h) => h.txid === txidFor(sessionOf(C, 0))), { timeout: 3000, message: 'trade2 settled (no spurious timeout)' });

        await sleep(300);
        const hist1 = allHistory().find((h) => h.txid === txidFor(sid1));
        const hist2 = allHistory().find((h) => h.txid === txidFor(sessionOf(C, 0)));
        assert.strictEqual(hist1.buyer.socketId, A.id, 'trade1 buyer attribution wrong');
        assert.strictEqual(hist1.seller.socketId, B.id, 'trade1 seller attribution wrong');
        assert.strictEqual(hist2.buyer.socketId, C.id, 'trade2 buyer attribution wrong');
        assert.strictEqual(hist2.seller.socketId, A.id, 'trade2 seller attribution wrong');

        assert.ok(!ordersOf(B.id).some((o) => o.uuid === bOrder.uuid), 'trade1 maker order not consumed');
        assert.ok(!ordersOf(A.id).some((o) => o.uuid === aOrder.uuid), 'trade2 maker order not consumed');

        const timeouts = [A, B, C].flatMap((c) => c.errors).filter((e) => /timed out/i.test(e));
        assert.strictEqual(timeouts.length, 0, `spurious swap timeout(s): ${timeouts.join('; ')}`);
        console.log('T4b PASS: both concurrent trades settled with their own txids, no spurious timeout');

        // ---- listener hygiene ---------------------------------------------
        await waitFor(() => activeSwapSessions() === 0, { timeout: 2000, message: 'all swap sessions closed after settle' });
        console.log('T4c PASS: no leftover swap sessions after both settled');

        A.socket.close();
        B.socket.close();
        C.socket.close();
        await stopServer(server);
        console.log('T4 (concurrent swaps): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('T4 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
