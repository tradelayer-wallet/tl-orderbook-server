'use strict';

/*
 * Round 11 regressions.
 *
 * R11-1: a book restores trade history only from its own market's log files. Log files were
 * matched by substring, so "futures-1" also loaded TRADE-futures-10 and "spot_2_1" also loaded
 * TRADE-spot_1_20. A spot book was matched under one orientation only (the first name had a
 * "-" typo), so its own history was missed whenever the book was created the other way round.
 */
const fs = require('fs');
const path = require('path');
const {
    assert, waitFor, startServer, stopServer, connectClient, rawSpotOrder, ordersOf, BUILD, workDir,
} = require('./common');

const orderbookManager = () => require(path.join(BUILD, 'services/orderbook')).orderbookManager;
const bookNamed = (name) => orderbookManager().orderbooks.find((b) => b.orderbookName === name);

const today = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const seedTradeLog = (market, marker) => {
    const record = { txid: marker.padEnd(64, '0'), time: 1, marker, type: 'SPOT', props: { amountDesired: 1, amountForSale: 1, price: 1 } };
    fs.writeFileSync(path.join(workDir, 'logs', `TRADE-${market}-${today()}.log`), `${JSON.stringify(record)}\n`);
};
const markersOf = (book) => book.historyTrades.map((t) => t.marker).sort();

(async () => {
    seedTradeLog('futures-10', 'f10');
    seedTradeLog('spot_1_20', 's120');
    seedTradeLog('spot_2_1', 'a21');
    seedTradeLog('spot_5_6', 'b56');
    seedTradeLog('spot_9_10', 'c910');

    const { server, url } = await startServer();
    try {
        const X = await connectClient(url, 'r11-history');

        X.socket.emit('new-order', {
            type: 'FUTURES', action: 'BUY', isLimitOrder: true, marketName: 'TL/USDT',
            keypair: { address: 'fut-1', pubkey: 'fpk' },
            props: { contract_id: 1, amount: 1, price: 1, levarage: 2, collateral: 1 },
        });
        await waitFor(() => bookNamed('futures-1'), { message: 'futures-1 book' });
        assert.deepStrictEqual(markersOf(bookNamed('futures-1')), [],
            'R11-1 FAIL: futures-1 restored the history of futures-10');

        // Created with orientation (2,1): its own log is spot_2_1.
        X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 2, id_desired: 1, amount: 1, price: 1 } }));
        await waitFor(() => bookNamed('spot_2_1'), { message: 'spot_2_1 book' });
        assert.deepStrictEqual(markersOf(bookNamed('spot_2_1')), ['a21'],
            'R11-1 FAIL: spot_2_1 restored the wrong market history');

        // Created with orientation (5,6): its own log is spot_5_6, which the old names never matched.
        X.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 5, id_desired: 6, amount: 1, price: 1 } }));
        await waitFor(() => bookNamed('spot_5_6'), { message: 'spot_5_6 book' });
        assert.deepStrictEqual(markersOf(bookNamed('spot_5_6')), ['b56'],
            'R11-1 FAIL: a spot book did not restore its own orientation log');

        // Created with the reverse orientation (10,9): the log is written under spot_9_10.
        X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 10, id_desired: 9, amount: 1, price: 1 } }));
        await waitFor(() => bookNamed('spot_10_9'), { message: 'spot_10_9 book' });
        assert.deepStrictEqual(markersOf(bookNamed('spot_10_9')), ['c910'],
            'R11-1 FAIL: a reversed spot book did not restore the other orientation log');

        console.log('R11-1 PASS: trade history restored from the exact market log, in either orientation');
        X.socket.close();
        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error('R11-1 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
