'use strict';

/*
 * Round 11 regressions: log durability and orderbook lifecycle.
 *
 * R11-2: saveLog returns only once its record is on disk. It appended asynchronously, so a
 * read-modify-write that followed it (updateOrderLog, the CANCALED/FILLED audit update) could
 * run before the record existed and leave it without its final state.
 *
 * R11-3: an orderbook that holds no orders is released. Books were never removed, so the
 * MAX_ORDERBOOKS cap counted every pair ever traded and, once reached, refused every new pair
 * until restart, even when all of the books were empty.
 */
process.env.MAX_ORDERBOOKS = '2';
const fs = require('fs');
const path = require('path');
const {
    assert, sleep, waitFor, waitForEvent, startServer, stopServer, connectClient, rawSpotOrder,
    ordersOf, sessionOf, activeSwapSessions, eventsOf, BUILD, workDir, negotiate, units,
} = require('./common');

const mixPure = require(path.join(BUILD, 'utils/pure/mix.pure'));
const orderbookManager = () => require(path.join(BUILD, 'services/orderbook')).orderbookManager;
const bookNamed = (name) => orderbookManager().orderbooks.find((b) => b.orderbookName === name);

const TXID = 'ef'.repeat(32);

const r11_2 = async () => {
    const uuid = 'r11-2-order';
    mixPure.saveLog('spot_9_8', 'ORDER', { uuid, socket_id: 's', timestamp: 1, props: {} });
    mixPure.updateOrderLog(['spot_9_8'], uuid, 'CANCALED');
    await sleep(200);

    const file = fs.readdirSync(path.join(workDir, 'logs')).find((f) => f.startsWith('ORDER-spot_9_8-'));
    assert.ok(file, 'R11-2 FAIL: order log file missing');
    const records = fs.readFileSync(path.join(workDir, 'logs', file), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.strictEqual(records.length, 1, 'R11-2 FAIL: record not written exactly once');
    assert.strictEqual(records[0].state, 'CANCALED', 'R11-2 FAIL: audit state lost to a write that raced the append');
    console.log('R11-2 PASS: a logged record is on disk before the next audit update');
};

const r11_3 = async () => {
    const { server, url } = await startServer();
    let M = null;
    let T = null;
    try {
        M = await connectClient(url, 'r11-3-maker');
        T = await connectClient(url, 'r11-3-taker');
        const sell = (idForSale) => M.socket.emit('new-order', rawSpotOrder({
            action: 'SELL', props: { id_for_sale: idForSale, id_desired: 1, amount: units(1), price: units(1) },
        }));

        // Two pairs fill the cap.
        sell(2);
        sell(3);
        await waitFor(() => ordersOf(M.id).length === 2, { message: 'r11-3: two books rested' });

        // Cancelling the only order of pair 3 leaves its book empty: it must be released.
        M.socket.emit('close-order', ordersOf(M.id).find((o) => o.props.id_for_sale === 3).uuid);
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'r11-3: cancelled' });
        const errorsBefore = M.errors.length;
        sell(4);
        await waitFor(() => ordersOf(M.id).length === 2 || M.errors.length > errorsBefore, { message: 'r11-3: third pair answered' });
        assert.ok(!M.errors.some((e) => /Too many orderbooks/.test(e)),
            `R11-3 FAIL: a pair was refused after its book was emptied by a cancel (${M.errors.join(' | ')})`);

        // Filling the only order of pair 2 empties its book through the settlement path.
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 1, id_desired: 2, amount: units(1), price: units(1) } }));
        await waitForEvent(T, 'new-channel', () => true, { message: 'r11-3: taker new-channel' });
        await negotiate(sessionOf(T), T, M);
        T.socket.emit('swap', { sessionId: sessionOf(T), eventName: 'BUYER:STEP6', data: TXID });
        await waitFor(() => activeSwapSessions() === 0, { message: 'r11-3: swap settled' });
        await waitFor(() => ordersOf(M.id).every((o) => o.props.id_for_sale !== 2), { message: 'r11-3: maker filled' });

        // The emptied market has no live book, yet a client still sees its trade, read from the logs.
        const viewsBefore = eventsOf(M, 'orderbook-data').length;
        M.socket.emit('update-orderbook', { type: 'SPOT', first_token: 1, second_token: 2 });
        await waitFor(() => eventsOf(M, 'orderbook-data').length > viewsBefore, { message: 'r11-3: market view answered' });
        const view = eventsOf(M, 'orderbook-data').slice(-1)[0].args[0];
        assert.ok(view.history.some((h) => h.txid === TXID), 'R11-3 FAIL: released market lost its trade history');
        assert.deepStrictEqual(view.orders, [], 'R11-3 FAIL: released market still lists orders');

        const errorsAfterFill = M.errors.length;
        sell(5);
        await waitFor(() => ordersOf(M.id).some((o) => o.props.id_for_sale === 5) || M.errors.length > errorsAfterFill, { message: 'r11-3: fifth pair answered' });
        assert.ok(!M.errors.some((e) => /Too many orderbooks/.test(e)),
            `R11-3 FAIL: a pair was refused after its book was emptied by a fill (${M.errors.join(' | ')})`);
        assert.strictEqual(orderbookManager().orderbooks.length, 2, 'R11-3 FAIL: empty books still counted against the cap');
        console.log('R11-3 PASS: an emptied orderbook is released by a cancel and by a fill');

    } finally {
        // Clients first: an open socket keeps server.close() from resolving.
        if (M) M.socket.close();
        if (T) T.socket.close();
        stopServer(server);
    }
};

// A book restored from its logs keeps history newest first, as it does while it is live.
const logDate = () => {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(day.getDate())}-${pad(day.getMonth() + 1)}-${day.getFullYear()}`;
};
const tradeLine = (marker, time) => JSON.stringify({ txid: marker.padEnd(64, '0'), time, marker, type: 'SPOT', props: { amountDesired: 1, amountForSale: 1, price: 1 } });

const r11_4 = async () => {
    fs.writeFileSync(path.join(workDir, 'logs', `TRADE-spot_7_1-${logDate()}.log`),
        `${tradeLine('older', 100)}\n${tradeLine('newer', 200)}\n`);

    const { server, url } = await startServer();
    let M = null;
    try {
        M = await connectClient(url, 'r11-4-maker');
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 7, id_desired: 1, amount: units(1), price: units(1) } }));
        await waitFor(() => orderbookManager().orderbooks.length === 1, { message: 'r11-4: book created' });
        const markers = orderbookManager().orderbooks[0].historyTrades.map((t) => t.marker);
        assert.deepStrictEqual(markers, ['newer', 'older'], 'R11-4 FAIL: restored history is not newest first');
        console.log('R11-4 PASS: restored history is newest first');
    } finally {
        if (M) M.socket.close();
        stopServer(server);
    }
};

// R11-5: a torn line (a write cut short by a crash) hides nothing around it. The audit update and
// the history restore both read past it.
const r11_5 = async () => {
    const orderFile = path.join(workDir, 'logs', `ORDER-spot_17_18-${logDate()}.log`);
    fs.writeFileSync(path.join(workDir, 'logs', `TRADE-spot_15_16-${logDate()}.log`),
        `${tradeLine('before', 100)}\n{"txid":"bb\n${tradeLine('after', 200)}\n`);
    fs.writeFileSync(orderFile, `{"uuid":"r11-5-torn\n${JSON.stringify({ uuid: 'r11-5', socket_id: 's', props: {} })}\n`);

    mixPure.updateOrderLog(['spot_17_18'], 'r11-5', 'CANCALED');
    const lines = fs.readFileSync(orderFile, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines[0], '{"uuid":"r11-5-torn', 'R11-5 FAIL: the torn line was rewritten');
    assert.strictEqual(JSON.parse(lines[1]).state, 'CANCALED', 'R11-5 FAIL: audit update stopped at a torn line');

    const { server, url } = await startServer();
    let M = null;
    try {
        M = await connectClient(url, 'r11-5');
        M.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 15, id_desired: 16, amount: units(1), price: units(1) } }));
        await waitFor(() => bookNamed('spot_15_16'), { message: 'r11-5: book created' });
        assert.deepStrictEqual(bookNamed('spot_15_16').historyTrades.map((t) => t.marker), ['after', 'before'],
            'R11-5 FAIL: a torn line hid the trades around it');
        console.log('R11-5 PASS: a torn log line hides neither the audit update nor the history around it');
    } finally {
        if (M) M.socket.close();
        stopServer(server);
    }
};

(async () => {
    try {
        await r11_2();
        await r11_3();
        await r11_4();
        await r11_5();
        process.exit(0);
    } catch (e) {
        console.error('R11 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
