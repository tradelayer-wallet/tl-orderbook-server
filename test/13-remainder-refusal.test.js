'use strict';

/*
 * Round 3 — a taker remainder that the book refuses is reported to the taker.
 *
 * Regression: Orderbook.addOrder re-entered the remainder through the manager and
 * then returned `{ data: res.data }`, which dropped `res.error`. The taker received
 * the generic 'Undifined Error' instead of the real reason, and a caller that only
 * checks `.error` (the many-orders path) saw nothing at all.
 *
 * Setup: the taker rests a SELL at price 2. A maker rests a SELL at price 1. The
 * taker's BUY (amount 2, price 3) fills the maker first; the remainder then crosses
 * the taker's own resting SELL and is refused with "same Account".
 * Expected: the taker's error names that reason.
 */
const {
    assert, waitFor, waitForEvent, startServer, stopServer, connectClient,
    rawSpotOrder, ordersOf, sessionOf, activeSwapSessions, negotiate,
} = require('./common');

const TXID = 'cd'.repeat(32);

(async () => {
    const { server, url } = await startServer();
    try {
        const M = await connectClient(url, 'r13-maker');
        const T = await connectClient(url, 'r13-taker');

        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1 }));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'r13: maker order rested' });
        T.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 2, id_for_sale: 2, id_desired: 1 }));
        await waitFor(() => ordersOf(T.id).length === 1, { message: 'r13: taker own sell rested' });

        const before = activeSwapSessions();
        const errorsBefore = T.errors.length;
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 2, price: 3, id_for_sale: 1, id_desired: 2 }));
        await waitFor(() => activeSwapSessions() === before + 1, { message: 'r13: swap with maker started' });
        await waitForEvent(T, 'new-channel', () => true, { message: 'r13: taker new-channel' });
        const sid = sessionOf(T);
        await negotiate(sid, T, M);
        T.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', data: TXID });

        await waitFor(() => T.errors.length > errorsBefore, { message: 'r13: taker received an error' });
        const msg = String(T.errors[T.errors.length - 1]);
        assert.ok(/same Account/.test(msg),
            `R13 FAIL: refused remainder reported as "${msg}", expected the real reason ("same Account")`);
        assert.ok(!/Undifined Error/.test(msg), 'R13 FAIL: generic error hides the refusal reason');
        console.log(`R13 PASS: refused taker remainder reported (${msg})`);

        M.socket.close(); T.socket.close();
        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error('R13 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
