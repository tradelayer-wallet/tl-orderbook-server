'use strict';

/*
 * Round 10 regressions, in the matching and resting-order limits added in round 8.
 * Each case fails on the code before this round:
 *   G  a resting order whose trade cannot settle exactly (its value is not a whole number of
 *      satoshis) was the first candidate for every taker at its price, so it refused them all, at
 *      no cost to its owner. It is now skipped when a settleable order exists at that price.
 *   H  the per-socket and total limits on resting orders were checked before matching, so an
 *      account at its limit could not place an order that trades at once. They now apply only where
 *      an order would come to rest, including the taker remainder of a trade, and that is checked
 *      before any maker is locked or any swap starts.
 *   I  after a restart the order history took the last 500 records of the log files in directory
 *      order, which is not time order across books. The loaded records are now sorted by time first.
 */
const fs = require('fs');
const path = require('path');
const {
    assert, waitFor, sleep, startServer, stopServer, connectClient, rawSpotOrder,
    allOrders, activeSwapSessions, sessionOf, txidFor, BUILD, workDir, negotiate,
} = require('./common');

// Each section trades on its own pair, so no section can match another section's resting orders.
const sellIds = (n) => ({ id_for_sale: 100 + n, id_desired: 200 + n });
const buyIds = (n) => ({ id_for_sale: 200 + n, id_desired: 100 + n });
const orderOf = (uuid) => allOrders().find((o) => o.uuid === uuid);
const mgr = () => require(path.join(BUILD, 'services/orderbook')).orderbookManager;
const { parseNewOrder } = require(path.join(BUILD, 'protocol/messages'));

(async () => {
    const { server, url } = await startServer();
    const clients = [];
    try {
        // G1: a dust maker (1e-8 at 0.29) is ahead of a settleable seller at the same price. The buyer
        // of one whole token trades with the settleable seller, and is not refused by the dust.
        const dust = await connectClient(url, 'r10-g-dust'); clients.push(dust);
        const honest = await connectClient(url, 'r10-g-honest'); clients.push(honest);
        const buyer = await connectClient(url, 'r10-g-buyer'); clients.push(buyer);
        dust.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 0.00000001, price: 0.29, ...sellIds(1) }));
        await waitFor(() => dust.inbox.some((e) => e.event === 'order:saved'), { message: 'G1: dust placed' });
        honest.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 0.29, ...sellIds(1) }));
        await waitFor(() => honest.inbox.some((e) => e.event === 'order:saved'), { message: 'G1: seller placed' });
        buyer.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 0.29, ...buyIds(1) }));
        await waitFor(() => buyer.inbox.some((e) => e.event === 'new-channel'), { message: 'G1: buyer traded with the settleable seller' });
        assert.equal(buyer.errors.length, 0, `G1 FAIL: buyer refused: ${buyer.errors}`);
        await negotiate(sessionOf(buyer), buyer, honest);
        buyer.socket.emit('swap', { sessionId: sessionOf(buyer), eventName: 'BUYER:STEP6', data: txidFor(sessionOf(buyer)) });
        await waitFor(() => activeSwapSessions() === 0, { message: 'G1: settled' });
        console.log('R10 G1 PASS: a dust order does not block a settleable seller at its price');

        // G2: only a dust order crosses. The buyer is refused, and nothing rests crossing the book.
        const dust2 = await connectClient(url, 'r10-g2-dust'); clients.push(dust2);
        const buyer2 = await connectClient(url, 'r10-g2-buyer'); clients.push(buyer2);
        dust2.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 0.00000001, price: 0.31, ...sellIds(2) }));
        await waitFor(() => dust2.inbox.some((e) => e.event === 'order:saved'), { message: 'G2: dust placed' });
        const before2 = allOrders().length;
        buyer2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 0.31, ...buyIds(2) }));
        await waitFor(() => buyer2.errors.length > 0, { message: 'G2: buyer answered' });
        assert.match(buyer2.errors[0], /whole number of satoshis/, 'G2 FAIL: wrong refusal');
        assert.equal(allOrders().length, before2, 'G2 FAIL: the refused buyer rested crossing the book');
        console.log('R10 G2 PASS: a taker whose only crossing order is unsettleable is refused and does not rest');

        // H1: an account at its per-socket limit still trades at once with a fully filled order.
        const owner = await connectClient(url, 'r10-h-owner'); clients.push(owner);
        const counter = await connectClient(url, 'r10-h-counter'); clients.push(counter);
        for (let i = 0; i < 500; i++) {
            const placed = await mgr().addOrder(parseNewOrder(rawSpotOrder({ action: 'SELL', amount: 1, price: 50 + i / 1000, ...sellIds(8) }), owner.id).data);
            if (placed.error) throw new Error(`H FAIL: resting order ${i} refused: ${placed.error}`);
        }
        counter.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, ...sellIds(9) }));
        await waitFor(() => counter.inbox.some((e) => e.event === 'order:saved'), { message: 'H1: counter placed' });
        const counterUuid = counter.inbox.find((e) => e.event === 'order:saved').args[0];
        const errorsH1 = owner.errors.length;
        owner.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, ...buyIds(9) }));
        await waitFor(() => owner.inbox.some((e) => e.event === 'new-channel') || owner.errors.length > errorsH1, { message: 'H1: owner answered' });
        assert.equal(owner.errors.length, errorsH1, `H1 FAIL: a trade at the limit was refused: ${owner.errors[owner.errors.length - 1]}`);
        await negotiate(sessionOf(owner), owner, counter);
        owner.socket.emit('swap', { sessionId: sessionOf(owner), eventName: 'BUYER:STEP6', data: txidFor(sessionOf(owner)) });
        await waitFor(() => activeSwapSessions() === 0, { message: 'H1: settled' });
        console.log('R10 H1 PASS: an account at its limit trades a fully filled order');

        // H2: the same account, with one more order that would rest (a remainder), is refused before
        // any lock or swap: the counter order stays unlocked and no swap starts.
        counter.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 2, ...sellIds(10) }));
        await waitFor(() => counter.inbox.filter((e) => e.event === 'order:saved').length === 2, { message: 'H2: counter placed' });
        const counterUuid2 = counter.inbox.filter((e) => e.event === 'order:saved')[1].args[0];
        const errorsH2 = owner.errors.length;
        owner.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 2, price: 2, ...buyIds(10) }));
        await waitFor(() => owner.errors.length > errorsH2, { message: 'H2: owner refused' });
        assert.match(owner.errors[owner.errors.length - 1], /Too many open orders/, 'H2 FAIL: wrong refusal');
        await sleep(30);
        assert.equal(orderOf(counterUuid2).lock, false, 'H2 FAIL: the maker was locked before the refusal');
        assert.equal(activeSwapSessions(), 0, 'H2 FAIL: a swap started for a trade whose remainder could not rest');
        assert.ok(orderOf(counterUuid2), 'H2 FAIL: the maker disappeared');
        console.log('R10 H2 PASS: a trade whose remainder could not rest is refused before any lock or swap');

        // I: after a restart the history is the newest 500 by time, across books. Three books' files
        // hold interleaved times (1..1200), so the last 500 lines of the files in any directory order
        // are not the newest 500 by time (ts 701..1200).
        const logs = path.join(workDir, 'logs');
        for (const f of fs.readdirSync(logs)) fs.unlinkSync(path.join(logs, f));
        const moment = require('moment');
        const today = moment().format('DD-MM-YYYY');
        for (const [book, r] of [['a', 0], ['b', 1], ['c', 2]]) {
            const lines = [];
            for (let ts = 1 + r; ts <= 1200; ts += 3) {
                lines.push(JSON.stringify({ uuid: `${book}-${ts}`, timestamp: ts, action: 'SELL', props: { amount: 100000000, price: 100000000 } }));
            }
            fs.writeFileSync(path.join(logs, `ORDER-${book}-${today}.log`), `${lines.join('\n')}\n`);
        }
        const { OrderbookManager } = require(path.join(BUILD, 'services/orderbook/manager.class'));
        const restarted = new OrderbookManager();
        const got = restarted.getOrdersHistory().map((h) => h.timestamp);
        const want = Array.from({ length: 500 }, (_, i) => 701 + i);
        assert.deepStrictEqual(got, want, 'I FAIL: the restored history is not the newest 500 in time order');
        console.log('R10 I PASS: the restored history is the newest 500 in time order');

        console.log('R10 PASS: all round 10 orderbook regressions');
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(2000)]);
        process.exit(0);
    } catch (e) {
        console.error('R10 FAIL:', e && e.stack || e);
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(2000)]);
        process.exit(1);
    }
})();
