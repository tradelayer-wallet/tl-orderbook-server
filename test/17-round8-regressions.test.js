'use strict';

/*
 * Round 8 regressions. Each case fails on the code before this round:
 *   A  a null or undefined update-orderbook payload crashed the whole process (no handler
 *      caught the TypeError from findByFilter);
 *   B  a remainder was rounded to 6 decimals, so quantity appeared from nothing (6e-7 -> 1e-6)
 *      or was lost (4e-7 -> 0, which left a zero-amount order resting);
 *   C  a trade refused after the maker was locked (LTC value not a whole satoshi) left the maker
 *      locked for ever: hidden from matching and not cancellable;
 *   D  the order history sent to clients was re-read from every log file on each placement
 *      (now a capped in-memory list);
 *   E  quantities with more than 8 decimal places were accepted and then rounded.
 */
const path = require('path');
const {
    assert, waitFor, sleep, startServer, stopServer, connectClient, rawSpotOrder,
    allOrders, activeSwapSessions, sessionOf, waitForEvent, txidFor, BUILD, negotiate, units,
} = require('./common');

// Each section trades on its own pair, so no section can match another section's resting orders.
const sellIds = (n) => ({ id_for_sale: 100 + n, id_desired: 200 + n });
const buyIds = (n) => ({ id_for_sale: 200 + n, id_desired: 100 + n });

const orderOf = (uuid) => allOrders().find((o) => o.uuid === uuid);

(async () => {
    const { server, url } = await startServer();
    const clients = [];
    try {
        const M = await connectClient(url, 'r8-maker'); clients.push(M);
        const T = await connectClient(url, 'r8-taker'); clients.push(T);
        const W = await connectClient(url, 'r8-watcher'); clients.push(W);

        // A: a malformed filter is refused; the process and the other sockets keep working.
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, ...sellIds(0) }));
        await waitFor(() => allOrders().length === 1, { message: 'A: book exists' });
        const errorsBefore = W.errors.length;
        for (const payload of [null, undefined, 5, 'x']) {
            W.socket.emit('update-orderbook', payload);
        }
        await waitFor(() => W.errors.length >= errorsBefore + 4, { message: 'A: refusals reported' });
        W.socket.emit('update-orderbook', { type: 'SPOT', first_token: 200, second_token: 100 });
        await waitForEvent(W, 'orderbook-data', (d) => d && d.orders.length === 1, { message: 'A: valid query still served' });
        console.log('R8 A PASS: malformed update-orderbook payloads are refused and the server stays up');

        // B: the remainder keeps its exact quantity. 1.0000006 - 1 = 0.0000006 (not 0.000001).
        const m1 = await connectClient(url, 'r8-b-maker'); clients.push(m1);
        const t1 = await connectClient(url, 'r8-b-taker'); clients.push(t1);
        m1.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1.0000006, price: 1, ...sellIds(1) }));
        await waitFor(() => m1.inbox.some((e) => e.event === 'order:saved'), { message: 'B: maker placed' });
        const mUuid = m1.inbox.find((e) => e.event === 'order:saved').args[0];
        t1.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, ...buyIds(1) }));
        await waitForEvent(t1, 'new-channel', () => true, { message: 'B: swap' });
        await negotiate(sessionOf(t1), t1, m1);
        t1.socket.emit('swap', { sessionId: sessionOf(t1), eventName: 'BUYER:STEP6', data: txidFor(sessionOf(t1)) });
        await waitFor(() => activeSwapSessions() === 0, { message: 'B: settled' });
        await sleep(30);
        assert.equal(orderOf(mUuid).props.amount, 60, `B FAIL: remainder is ${orderOf(mUuid).props.amount} units, expected 60 (6e-7)`);
        console.log('R8 B1 PASS: remainder 6e-7 kept exactly');

        // B2: 1.0000004 - 1 = 4e-7 must stay 4e-7 and never become a zero-amount order.
        const m2 = await connectClient(url, 'r8-b2-maker'); clients.push(m2);
        const t2 = await connectClient(url, 'r8-b2-taker'); clients.push(t2);
        m2.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1.0000004, price: 1, ...sellIds(2) }));
        await waitFor(() => m2.inbox.some((e) => e.event === 'order:saved'), { message: 'B2: maker placed' });
        const m2Uuid = m2.inbox.find((e) => e.event === 'order:saved').args[0];
        t2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, ...buyIds(2) }));
        await waitForEvent(t2, 'new-channel', () => true, { message: 'B2: swap' });
        await negotiate(sessionOf(t2), t2, m2);
        t2.socket.emit('swap', { sessionId: sessionOf(t2), eventName: 'BUYER:STEP6', data: txidFor(sessionOf(t2)) });
        await waitFor(() => activeSwapSessions() === 0, { message: 'B2: settled' });
        await sleep(30);
        assert.equal(orderOf(m2Uuid).props.amount, 40, 'B2 FAIL: remainder rounded away');
        console.log('R8 B2 PASS: remainder 4e-7 kept, no zero-amount order');

        // C: a trade refused for its value (13779 units x 1.5 is not whole satoshis) must leave the
        // maker unlocked, so it can still be cancelled by its owner.
        const m3 = await connectClient(url, 'r8-c-maker'); clients.push(m3);
        const t3 = await connectClient(url, 'r8-c-taker'); clients.push(t3);
        m3.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 0.00013779, price: 1.5, ...sellIds(3) }));
        await waitFor(() => m3.inbox.some((e) => e.event === 'order:saved'), { message: 'C: maker placed' });
        const m3Uuid = m3.inbox.find((e) => e.event === 'order:saved').args[0];
        const errs3 = t3.errors.length;
        t3.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 0.00013779, price: 1.5, ...buyIds(3) }));
        await waitFor(() => t3.errors.length > errs3, { message: 'C: taker refused' });
        assert.match(t3.errors[t3.errors.length - 1], /whole number of satoshis/, 'C FAIL: wrong refusal');
        await sleep(30);
        assert.equal(orderOf(m3Uuid).lock, false, 'C FAIL: refused trade left the maker locked');
        m3.socket.emit('close-order', m3Uuid);
        await waitFor(() => !orderOf(m3Uuid), { message: 'C: maker cancelled' });
        console.log('R8 C PASS: a refused trade leaves the maker unlocked and cancellable');

        // E: a quantity with 9 decimal places is refused at intake, nothing rests.
        const e1 = await connectClient(url, 'r8-e'); clients.push(e1);
        const before = allOrders().length;
        e1.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { ...sellIds(5), amount: 1.000000001 * 1e8, price: units(1) } }));
        await waitFor(() => e1.errors.length > 0, { message: 'E: refused' });
        assert.match(e1.errors[0], /positive integer number of units/);
        assert.equal(allOrders().length, before, 'E FAIL: a 9-decimal order rested');
        console.log('R8 E PASS: 9-decimal quantity refused at intake');

        // D: the history sent to clients is capped, and it is served from memory.
        const mgr = require(path.join(BUILD, 'services/orderbook')).orderbookManager;
        const { parseNewOrder } = require(path.join(BUILD, 'protocol/messages'));
        const dClients = [];
        for (let k = 0; k < 3; k++) dClients.push(await connectClient(url, `r8-d${k}`));
        clients.push(...dClients);
        for (let i = 0; i < 600; i++) {
            const owner = dClients[i % 3];
            const f = parseNewOrder(rawSpotOrder({ action: 'SELL', props: { ...sellIds(4), amount: units(1), price: Math.round((5 + i / 1000) * 1e8) } }), owner.id);
            await mgr.addOrder(f.data);
        }
        const history = mgr.getOrdersHistory();
        const newestPrice = 5 + 599 / 1000;
        assert.equal(history.length, 500, `D FAIL: expected 500 records, got ${history.length}`);
        assert.ok(history.some((o) => o.props.price === units(newestPrice)),
            'D FAIL: the history does not hold the newest order (it must be the most recent 500)');
        console.log('R8 D PASS: order history is the most recent 500, kept in memory');

        // F: resting orders are bounded per account. The 501st order of one account is refused.
        const f1 = await connectClient(url, 'r8-f'); clients.push(f1);
        for (let i = 0; i < 500; i++) {
            const placed = await mgr.addOrder(parseNewOrder(rawSpotOrder({ action: 'SELL', props: { ...sellIds(6), amount: units(1), price: Math.round((50 + i / 1000) * 1e8) } }), f1.id).data);
            if (placed.error) throw new Error(`F FAIL: order ${i} refused: ${placed.error}`);
        }
        const over = await mgr.addOrder(parseNewOrder(rawSpotOrder({ action: 'SELL', props: { ...sellIds(6), amount: units(1), price: Math.round((60) * 1e8) } }), f1.id).data);
        assert.match(String(over.error), /at most 500 per account/, 'F FAIL: the 501st order of one account was accepted');
        console.log('R8 F PASS: resting orders are bounded per account');

        console.log('R8 PASS: all round 8 orderbook regressions');
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(2000)]);
        process.exit(0);
    } catch (e) {
        console.error('R8 FAIL:', e && e.stack || e);
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(2000)]);
        process.exit(1);
    }
})();
