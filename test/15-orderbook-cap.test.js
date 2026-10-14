'use strict';

/*
 * Round 6 — the orderbook registry is bounded.
 *
 * Any client can name a market pair, and each new pair creates an in-memory book
 * plus log files. Regression: no cap, so the registry grew without limit.
 * Expected: with MAX_ORDERBOOKS=3, a fourth distinct pair is refused with an explicit
 * error and creates no book; existing pairs keep accepting orders.
 */
process.env.MAX_ORDERBOOKS = '3';
const path = require('path');
const {
    assert, waitFor, startServer, stopServer, connectClient, rawSpotOrder, ordersOf, BUILD,
} = require('./common');
const getOrderbookManager = () => require(path.join(BUILD, 'services/orderbook')).orderbookManager;

(async () => {
    const { server, url } = await startServer();
    try {
        const X = await connectClient(url, 'r6cap');
        for (const idForSale of [2, 3, 4]) {
            X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: idForSale, id_desired: 1 }));
        }
        await waitFor(() => ordersOf(X.id).length === 3, { message: 'r6cap: three pairs rested' });

        const errorsBefore = X.errors.length;
        X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 5, id_desired: 1 }));
        await waitFor(() => X.errors.length > errorsBefore, { message: 'r6cap: fourth pair answered' });
        assert.ok(/Too many orderbooks/.test(String(X.errors[X.errors.length - 1])),
            `R6cap FAIL: fourth pair not refused explicitly (got "${X.errors[X.errors.length - 1]}")`);
        assert.strictEqual(getOrderbookManager().orderbooks.length, 3, 'R6cap FAIL: refused pair still created a book');

        X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 2, id_for_sale: 2, id_desired: 1 }));
        await waitFor(() => ordersOf(X.id).length === 4, { message: 'r6cap: existing pair still accepts orders' });
        console.log('R6cap PASS: orderbook registry capped; existing pairs unaffected');
        X.socket.close();
        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error('R6cap FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
