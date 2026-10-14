'use strict';

process.env.SWAP_TIMEOUT_MS = '1500';

/*
 * Earlier-PR regression: swap timeout must unlock the matched order (no
 * permanent lock), clean up its listeners, and (fix #6) must NOT have written
 * the FILLED log marker before settlement.
 */
const fs = require('fs');
const path = require('path');
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, ordersOf, activeSwapSessions,
} = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        const M = await connectClient(url, 'maker');
        const T = await connectClient(url, 'taker');

        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, keypair: { address: 'addr-m', pubkey: 'pk-m' } }));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'maker order on book' });
        const makerOrder = ordersOf(M.id)[0];

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2, keypair: { address: 'addr-t', pubkey: 'pk-t' } }));
        await waitFor(() => eventsOf(T, 'new-channel').length === 1, { message: 'swap channel opened' });

        // Nobody completes the swap -> SWAP_TIMEOUT_MS must fire.
        await waitFor(() => T.errors.length > 0, { timeout: 6000, message: 'swap timeout error' });
        assert.ok(/timed out/i.test(T.errors[0]), `expected timeout error, got: ${T.errors[0]}`);

        await sleep(200);
        const onBook = ordersOf(M.id);
        assert.strictEqual(onBook.length, 1, 'timeout must not remove the matched order');
        assert.strictEqual(onBook[0].uuid, makerOrder.uuid, 'wrong order left on book');
        assert.strictEqual(onBook[0].lock, false, 'timeout must unlock the matched order');
        console.log('TIMEOUT PASS: silent counterparty -> order unlocked (not locked forever)');

        // fix #6: the FILLED marker must not be written before settlement
        const logText = fs.readdirSync(path.join(process.cwd(), 'logs'))
            .filter((f) => f.startsWith('ORDER-'))
            .map((f) => fs.readFileSync(path.join(process.cwd(), 'logs', f), 'utf8'))
            .join('\n');
        const entry = logText.split('\n').find((l) => l.includes(makerOrder.uuid));
        assert.ok(entry, 'maker order should have an ORDER log entry');
        assert.ok(!entry.includes('FILLED'),
            `FILLED written before settlement: ${entry}`);
        console.log('TIMEOUT PASS: no FILLED marker written before settlement (fix #6)');

        await waitFor(() => activeSwapSessions() === 0, { timeout: 2000, message: 'swap session cleaned up' });
        console.log('TIMEOUT PASS: swap listeners/timer cleaned up after settle');

        M.socket.close();
        T.socket.close();
        await stopServer(server);
        console.log('TIMEOUT: ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('TIMEOUT FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
