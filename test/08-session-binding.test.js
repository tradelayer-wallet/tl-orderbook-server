'use strict';

/*
 * N1 (round 2, critical) — swap events must be bound to a session, not a socket.
 *
 * Proven bug (f7f1b28, probes P1/P1b): swap events were routed by socket
 * id (`<socketId>::swap`). A buyer in two concurrent sessions had one
 * BUYER:STEP6 settle BOTH sessions, and a relayed event reached the wrong
 * counterparty.
 *
 * Expected (post-fix):
 *  a) one settle event settles only the session it names (shared socket X)
 *  b) relay goes only to the counterparty of the named session
 *  c) an event with no sessionId, or only the old socket-keyed channel, is rejected
 *     and never relayed or settled
 *  d) an outsider holding a session id is still rejected (not a participant)
 *  e) session ids are 256-bit random, distinct per session
 *  f) a settled session's id stops routing (late / replayed events rejected)
 *  g) a non-object payload is rejected
 */
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, emitSwap, sessionOf, ordersOf, allHistory,
    activeSwapSessions,
} = require('./common');

// Opens a swap in which `taker` buys from `maker`. Each swap uses its own token
// pair so concurrent swaps never cross-match. Returns the server-issued sessionId.
const openSwap = async (maker, taker, tokA, tokB, tag) => {
    const makerBefore = eventsOf(maker, 'new-channel').length;
    const takerBefore = eventsOf(taker, 'new-channel').length;
    maker.socket.emit('new-order', rawSpotOrder({
        action: 'SELL', amount: 1, price: 1, id_for_sale: tokB, id_desired: tokA,
        keypair: { address: `${tag}-m`, pubkey: `${tag}-m` },
    }));
    await waitFor(() => ordersOf(maker.id).some((o) => o.keypair.address === `${tag}-m`), { message: `${tag} maker rested` });
    taker.socket.emit('new-order', rawSpotOrder({
        action: 'BUY', amount: 1, price: 1, id_for_sale: tokA, id_desired: tokB,
        keypair: { address: `${tag}-t`, pubkey: `${tag}-t` },
    }));
    await waitFor(() => eventsOf(maker, 'new-channel').length === makerBefore + 1
        && eventsOf(taker, 'new-channel').length === takerBefore + 1, { message: `${tag} channel opened` });
    return sessionOf(taker);
};

const relayedWith = (client, data) =>
    eventsOf(client, 'swap').some((e) => e.args[0] && e.args[0].data === data);

const { txidOf, txidFor, negotiate, sendStep, NEGOTIATION_STEPS } = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        // Shared socket X is the BUYER in two concurrent sessions:
        //   S1: X (buyer) <-> M1 (seller)     tokens 10/11
        //   S2: X (buyer) <-> M2 (seller)     tokens 12/13
        const X = await connectClient(url, 'X');
        const M1 = await connectClient(url, 'M1');
        const M2 = await connectClient(url, 'M2');
        const S1 = await openSwap(M1, X, 10, 11, 's1');
        const S2 = await openSwap(M2, X, 12, 13, 's2');

        // ---- e) ids are unguessable and distinct ----------------------------
        assert.match(S1, /^[0-9a-f]{64}$/, 'N1 FAIL: session id is not 256-bit hex');
        assert.match(S2, /^[0-9a-f]{64}$/, 'N1 FAIL: session id is not 256-bit hex');
        assert.notStrictEqual(S1, S2, 'N1 FAIL: two sessions share one id');
        assert.strictEqual(activeSwapSessions(), 2, 'N1 FAIL: both sessions should be open');
        console.log('N1e PASS: session ids are 256-bit random and distinct');

        // ---- c) session-less and socket-keyed events are rejected ----------
        X.socket.emit('swap', { eventName: 'BUYER:STEP6', socketId: X.id, data: txidOf('no-session-txid') });
        await waitFor(() => X.errors.some((e) => /sessionId/.test(e)), { message: 'session-less event rejected' });
        X.socket.emit(`${X.id}::swap`, { eventName: 'SELLER:STEP1', socketId: X.id, data: 'old-channel-probe' });
        X.socket.emit('swap', 'not-an-object');
        await waitFor(() => X.errors.length >= 2, { message: 'non-object payload rejected' });
        await sleep(300);
        assert.ok(!relayedWith(M1, 'old-channel-probe') && !relayedWith(M1, txidOf('no-session-txid')),
            'N1 FAIL: session-less or socket-keyed event was relayed');
        assert.ok(!allHistory().some((h) => h.txid === txidOf('no-session-txid')),
            'N1 FAIL: session-less BUYER:STEP6 settled a swap');
        assert.strictEqual(activeSwapSessions(), 2, 'N1 FAIL: session-less event changed session state');
        console.log('N1c PASS: session-less, socket-keyed and non-object swap events are rejected, never relayed or settled');

        // ---- d) outsider holding a session id is rejected -------------------
        const W = await connectClient(url, 'W');
        emitSwap(W, S1, 'TERMINATE_TRADE', 'outsider abort');
        emitSwap(W, S1, 'BUYER:STEP6', txidOf('outsider-txid'));
        await waitFor(() => W.errors.some((e) => /foreign|unknown/.test(e)), { message: 'outsider rejected' });
        await sleep(300);
        assert.ok(!allHistory().some((h) => h.txid === txidOf('outsider-txid')), 'N1 FAIL: outsider settled a swap it is not part of');
        assert.ok(!relayedWith(M1, 'outsider abort') && !relayedWith(X, 'outsider abort'),
            'N1 FAIL: outsider event was relayed to a participant');
        assert.strictEqual(activeSwapSessions(), 2, 'N1 FAIL: outsider terminated a session');
        console.log('N1d PASS: outsider with a leaked session id can neither settle, terminate nor relay');

        // ---- b) relay is confined to the named session's counterparty -------
        await sendStep(S1, X, M1, 0);
        await sendStep(S1, X, M1, 1);
        await sleep(300);
        assert.ok(!eventsOf(M2, 'swap').some((e) => e.args[0] && e.args[0].sessionId === S1), 'N1 FAIL: S1 event leaked to M2 (other session)');
        assert.ok(!eventsOf(M1, 'swap').some((e) => e.args[0] && e.args[0].sessionId === S1 && e.args[0].socketId === M1.id),
            'N1 FAIL: a participant received its own event back');
        console.log('N1b PASS: relay reaches only the paired counterparty of the named session');

        // ---- a) one settle event settles only its own session ---------------
        for (let i = 2; i < NEGOTIATION_STEPS.length; i++) await sendStep(S1, X, M1, i);
        emitSwap(X, S1, 'BUYER:STEP6', txidFor(S1));
        await waitFor(() => allHistory().some((h) => h.txid === txidFor(S1)), { timeout: 3000, message: 'S1 settled' });
        await sleep(300);
        assert.strictEqual(activeSwapSessions(), 1, 'N1 FAIL: settling S1 also settled S2 (cross-session bleed)');
        assert.ok(!allHistory().some((h) => h.txid === txidFor(S2)), 'N1 FAIL: S2 recorded a fill it never received');
        assert.ok(ordersOf(M2.id).some((o) => o.keypair.address === 's2-m' && o.lock === true),
            'N1 FAIL: S2 maker order was unlocked by S1 settlement');
        console.log('N1a PASS: a single BUYER:STEP6 on the shared socket settles only the session it names');

        // ---- f) a settled session id no longer routes -----------------------
        M1.socket.emit('swap', { sessionId: S1, eventName: 'SELLER:STEP1', socketId: M1.id, data: 'late-after-settle' });
        await waitFor(() => M1.errors.some((e) => /foreign|unknown/.test(e)), { message: 'late event on settled session rejected' });
        await sleep(200);
        assert.ok(!relayedWith(X, 'late-after-settle'), 'N1 FAIL: event on a settled session was relayed');
        console.log('N1f PASS: events on a settled session id are rejected');

        // S2 still settles normally with its own txid.
        await negotiate(S2, X, M2);
        emitSwap(X, S2, 'BUYER:STEP6', txidFor(S2));
        await waitFor(() => allHistory().some((h) => h.txid === txidFor(S2)), { timeout: 3000, message: 'S2 settled' });
        assert.strictEqual(activeSwapSessions(), 0, 'N1 FAIL: session registry not drained after both settled');

        for (const c of [X, M1, M2, W]) c.socket.close();
        await stopServer(server);
        console.log('N1 (session binding): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('N1 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
