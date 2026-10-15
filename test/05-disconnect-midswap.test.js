'use strict';

// Short swap timeout so the mid-swap disconnect resolves quickly.
process.env.SWAP_TIMEOUT_MS = '2000';

/*
 * S3 — Disconnected counterparty mid-swap.
 *
 * Proven bug (pre-fix): orderbook.class.ts updatePlacedOrdersForSocketId did
 * `socketService.io.sockets.sockets.get(socketid).emit(...)` unchecked; with the
 * counterparty gone this threw a TypeError which was then caught by addOrder's
 * catch and returned to the surviving client as "Cannot read properties of
 * undefined (reading 'emit')" — masking the real error (part 1) and, on the
 * success path, aborting before the taker's unfilled remainder was re-added, so
 * the remainder was silently lost (part 2).
 *
 * Expected (post-fix): null-check + graceful return.
 *  1) mid-swap disconnect -> surviving client gets the clean swap-timeout error
 *  2) counterparty gone at settlement -> trade succeeds, no order:error, and
 *     the taker's unfilled remainder is re-added to the book
 */
const fs = require('fs');
const path = require('path');
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, emitSwap, sessionOf, ordersOf, allHistory, negotiate, units,
} = require('./common');

const { txidOf } = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- 1) disconnect mid-swap -> clean timeout error ----------------
        const M = await connectClient(url, 'maker');
        const T = await connectClient(url, 'taker');

        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, id_for_sale: 2, id_desired: 1, keypair: { address: 'addr-m', pubkey: 'pk-m' } }));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'maker order on book' });

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2, keypair: { address: 'addr-t', pubkey: 'pk-t' } }));
        await waitFor(() => eventsOf(T, 'new-channel').length === 1, { message: 'swap channel opened' });

        M.socket.close(); // counterparty vanishes mid-swap
        await waitFor(() => T.errors.length > 0, { timeout: 6000, message: 'taker gets swap failure' });
        assert.ok(/timed out/i.test(T.errors[0]),
            `S3 FAIL: expected a clean swap-timeout error, got: ${T.errors[0]}`);
        assert.ok(!/Cannot read propert/i.test(T.errors[0]),
            `S3 FAIL: TypeError leaked to the client: ${T.errors[0]}`);
        console.log('S3a PASS: counterparty disconnect mid-swap -> clean timeout error, no TypeError');

        // server must still be healthy
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 21, id_desired: 20, keypair: { address: 'addr-t-h', pubkey: 'pk-t-h' } }));
        await waitFor(() => eventsOf(T, 'order:saved').length >= 1, { message: 'server healthy after disconnect' });
        console.log('S3b PASS: server keeps serving after the disconnect');

        // ---- 2) counterparty gone at settlement -> remainder preserved ----
        const M2 = await connectClient(url, 'maker2');
        const T2 = await connectClient(url, 'taker2');

        M2.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 2, price: 3, id_for_sale: 8, id_desired: 7, keypair: { address: 'addr-m2', pubkey: 'pk-m2' } }));
        await waitFor(() => ordersOf(M2.id).length === 1, { message: 'maker2 order on book' });
        const m2Order = ordersOf(M2.id)[0];

        // Taker wants 3 while only 2 rest -> 1 unit unfilled remainder expected.
        T2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 3, price: 3, id_for_sale: 7, id_desired: 8, keypair: { address: 'addr-t2', pubkey: 'pk-t2' } }));
        await waitFor(() => eventsOf(T2, 'new-channel').length === 1, { message: 'second swap channel opened' });

        // The maker signs (SELLER:STEP5), then disappears before the buyer reports. Without its
        // signature no BUYER:STEP6 can come, so the disconnect has to follow the signing step.
        const sid2 = sessionOf(T2);
        await negotiate(sid2, T2, M2);
        M2.socket.close();
        await sleep(200);
        emitSwap(T2, sid2, 'BUYER:STEP6', txidOf('txid-s3'));
        await waitFor(() => allHistory().some((h) => h.txid === txidOf('txid-s3')), { timeout: 3000, message: 'trade settled' });

        await sleep(300);
        assert.strictEqual(T2.errors.length, 0,
            `S3 FAIL: order:error leaked on the success path: ${T2.errors.join('; ')}`);
        const remainder = ordersOf(T2.id);
        assert.strictEqual(remainder.length, 1, `S3 FAIL: taker's unfilled remainder lost (orders: ${JSON.stringify(remainder)})`);
        assert.strictEqual(remainder[0].props.amount, units(1), 'S3 FAIL: wrong remainder amount');
        console.log('S3c PASS: success path with vanished counterparty -> no TypeError, unfilled remainder preserved');

        // the fully-filled maker order must be logged FILLED after settlement
        const logFiles = fs.readdirSync(path.join(process.cwd(), 'logs'));
        const traded = logFiles
            .filter((f) => f.startsWith('ORDER-') && f.includes('spot_8_7'))
            .map((f) => fs.readFileSync(path.join(process.cwd(), 'logs', f), 'utf8'))
            .join('\n');
        assert.ok(traded.includes(m2Order.uuid) && /"state":"FILLED"/.test(traded),
            'S3 FAIL: fully-filled maker order not marked FILLED after settlement');
        console.log('S3d PASS: FILLED marker written only after successful settlement');

        T.socket.close();
        T2.socket.close();
        await stopServer(server);
        console.log('S3 (disconnect mid-swap): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('S3 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
