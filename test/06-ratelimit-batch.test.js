'use strict';

/*
 * Fix #4 — batch cap vs rate limiter mismatch.
 *
 * Proven bug (pre-fix): many-orders accepted up to 100 orders but the per-socket
 * burst was 50, so a legitimate 100-ladder was half-dropped (and the remainder
 * vanished without a per-order error). Also update-orderbook and swap relay
 * events were unlimited.
 *
 * Expected (post-fix): order burst raised to 100 (= batch cap), dropped
 * remainders surface via order:error with counts, update-orderbook and swap
 * relay events are rate limited too.
 */
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, sessionOf, units,
} = require('./common');

const batchOf = (n, startPrice = 1) => Array.from({ length: n }, (_, i) =>
    rawSpotOrder({
        action: 'BUY',
        props: { id_for_sale: 2, id_desired: 1, amount: units(1), price: units(startPrice + i * 0.0001) },
        keypair: { address: `addr-batch-${process.pid}-${i}`, pubkey: `pk-batch-${i}` },
    }));

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- 1) full 100-order ladder must not be half-dropped ------------
        const R = await connectClient(url, 'ladder');
        R.socket.emit('many-orders', batchOf(100));
        await waitFor(() => eventsOf(R, 'order:saved').length === 1, { timeout: 10000, message: 'batch accepted' });
        await sleep(300);
        assert.strictEqual(R.errors.length, 0,
            `batch cap PASS but limiter dropped orders: ${R.errors.join('; ')}`);
        console.log('RATEa PASS: 100-order many-orders batch fully accepted (burst now covers the batch cap)');

        // ---- 2) a second immediate batch is capped, remainder reported ----
        R.socket.emit('many-orders', batchOf(100, 5));
        await waitFor(() => R.errors.length > 0, { timeout: 10000, message: 'second batch rate limited' });
        const err = R.errors[R.errors.length - 1];
        assert.ok(/dropped \d+ of 100 orders in batch/.test(err),
            `expected dropped-remainder report, got: ${err}`);
        console.log(`RATEb PASS: overflow batch remainder surfaced via order:error ("${err}")`);

        // ---- 3) oversized batch rejected ---------------------------------
        const R2 = await connectClient(url, 'bigbatch');
        R2.socket.emit('many-orders', batchOf(101));
        await waitFor(() => R2.errors.length > 0, { message: 'oversized batch rejected' });
        assert.ok(/Batch too large/.test(R2.errors[0]), `expected batch-cap error, got: ${R2.errors[0]}`);
        console.log('RATEc PASS: >100 order batch rejected with order:error');

        // ---- 4) update-orderbook is rate limited -------------------------
        const Q = await connectClient(url, 'querier');
        const filter = { type: 'SPOT', first_token: 1, second_token: 2 };
        for (let i = 0; i < 80; i++) Q.socket.emit('update-orderbook', filter);
        await waitFor(() => Q.errors.length > 0, { message: 'update-orderbook rate limited' });
        assert.ok(/Rate limit exceeded/.test(Q.errors[0]), `expected rate-limit error, got: ${Q.errors[0]}`);
        await sleep(300);
        assert.ok(eventsOf(Q, 'orderbook-data').length > 0, 'queries inside the burst must still be served');
        console.log('RATED PASS: update-orderbook rate limited (burst served, overflow rejected)');

        // ---- 5) swap relay events are rate limited (inside a live session) -
        const F1 = await connectClient(url, 'swap-maker');
        const F2 = await connectClient(url, 'swap-taker');
        F1.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 9, id_for_sale: 31, id_desired: 30, keypair: { address: 'addr-f1', pubkey: 'pk-f1' } }));
        await waitFor(() => eventsOf(F1, 'order:saved').length === 1, { message: 'swap-maker order on book' });
        F2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 9, id_for_sale: 30, id_desired: 31, keypair: { address: 'addr-f2', pubkey: 'pk-f2' } }));
        await waitFor(() => eventsOf(F2, 'new-channel').length === 1, { message: 'swap channel open for relay flood' });

        for (let i = 0; i < 80; i++) {
            F2.socket.emit('swap', { sessionId: sessionOf(F2), eventName: 'SELLER:STEP1', socketId: F2.id, data: 'flood' });
        }
        await waitFor(() => F2.errors.some((e) => /Rate limit exceeded/.test(e)), { message: 'swap relay rate limited' });
        await sleep(300);
        // Every flooded event is out of step (SELLER:STEP1 comes from the seller), so none is relayed.
        const relayed = eventsOf(F1, 'swap').length;
        assert.strictEqual(relayed, 0, `out-of-step events were relayed (relayed ${relayed} of 80)`);
        console.log(`RATEe PASS: swap-channel flood rate limited, nothing relayed (${relayed}/80 relayed to counterparty)`);

        R.socket.close();
        R2.socket.close();
        Q.socket.close();
        F1.socket.close();
        F2.socket.close();
        await stopServer(server);
        console.log('RATE LIMIT: ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('RATE LIMIT FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
