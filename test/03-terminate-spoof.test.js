'use strict';

/*
 * S2 — Spoofed TERMINATE_TRADE.socketId must not delete the maker's order.
 *
 * Proven attack (pre-fix): the taker emits TERMINATE_TRADE with the *maker's*
 * socketId in the client-supplied SwapEvent.socketId field; the server trusted
 * it and called removeOrder(match.uuid, match.socket_id) with the order's own
 * id, so the ownership check could never fire and the maker's order was deleted
 * (left lock:true).
 *
 * Expected (post-fix): the terminator is derived from the emitting socket.
 *  a) forged terminate  -> maker's order stays on the book, unlocked
 *  b) owner terminate   -> maker's order is removed (original semantics)
 *  c) seller-faked BUYER:STEP6 must not settle the swap (buyer-scope)
 */
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, emitSwap, sessionOf, ordersOf, allHistory,
} = require('./common');

const { txidOf, txidFor, negotiate, units } = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        const M = await connectClient(url, 'maker');
        const T = await connectClient(url, 'taker');

        // ---- a) forged terminate -------------------------------------------
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, keypair: { address: 'addr-m', pubkey: 'pk-m' } }));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'maker order on book' });
        const makerOrder = ordersOf(M.id)[0];
        const makerUuid = makerOrder.uuid;

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2, keypair: { address: 'addr-t', pubkey: 'pk-t' } }));
        await waitFor(() => eventsOf(T, 'new-channel').length === 1 && eventsOf(M, 'new-channel').length === 1,
            { message: 'swap channel opened' });

        // Taker forges the maker's socket id in the payload's socketId field.
        emitSwap(T, sessionOf(T), 'TERMINATE_TRADE', 'attacker abort', M.id);
        await waitFor(() => T.errors.length > 0, { message: 'taker sees terminate error' });
        assert.ok(T.errors[0].includes('attacker abort'), `unexpected error: ${T.errors[0]}`);
        await sleep(300);

        const after = ordersOf(M.id);
        assert.strictEqual(after.length, 1,
            `S2 FAIL: maker's order was deleted by a spoofed TERMINATE (orders now: ${JSON.stringify(after)})`);
        assert.strictEqual(after[0].uuid, makerUuid, 'S2 FAIL: wrong order left on book');
        assert.strictEqual(after[0].lock, false, 'S2 FAIL: maker order left locked');
        console.log('S2a PASS: forged TERMINATE (payload socketId = maker) left the maker order on the book, unlocked');

        // ---- b) owner terminate removes the order --------------------------
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 2, price: 5, id_for_sale: 4, id_desired: 3, keypair: { address: 'addr-m2', pubkey: 'pk-m2' } }));
        await waitFor(() => ordersOf(M.id).length === 2, { message: 'second maker order on book' });
        const maker2 = ordersOf(M.id).find((o) => o.props.price === units(5));

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 2, price: 5, id_for_sale: 3, id_desired: 4, keypair: { address: 'addr-t2', pubkey: 'pk-t2' } }));
        await waitFor(() => eventsOf(M, 'new-channel').length === 2, { message: 'second swap channel opened' });

        // The maker (owner of the resting order) terminates on its own channel.
        emitSwap(M, sessionOf(M), 'TERMINATE_TRADE', 'owner abort');
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'owner terminate removes maker order' });
        assert.ok(!ordersOf(M.id).some((o) => o.uuid === maker2.uuid),
            'S2 FAIL: owner terminate did not remove the owner\'s order');
        assert.ok(ordersOf(M.id).some((o) => o.uuid === makerUuid),
            'S2 FAIL: owner terminate removed an unrelated order');
        console.log('S2b PASS: legitimate owner TERMINATE still removes the owner\'s order');

        // ---- c) seller cannot fake a fill ---------------------------------
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 3, price: 7, id_for_sale: 6, id_desired: 5, keypair: { address: 'addr-m3', pubkey: 'pk-m3' } }));
        await waitFor(() => ordersOf(M.id).some((o) => o.props.price === units(7)), { message: 'third maker order on book' });

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 3, price: 7, id_for_sale: 5, id_desired: 6, keypair: { address: 'addr-t3', pubkey: 'pk-t3' } }));
        await waitFor(() => eventsOf(M, 'new-channel').length === 3, { message: 'third swap channel opened' });

        // The seller (M) tries to fake the buyer's final step with a fake txid.
        emitSwap(M, sessionOf(M), 'BUYER:STEP6', txidOf('fake-txid'));
        await sleep(600);
        assert.ok(!allHistory().some((h) => h.txid === txidOf('fake-txid')),
            'S2 FAIL: seller-faked BUYER:STEP6 was recorded as a fill');
        assert.ok(ordersOf(M.id).some((o) => o.props.price === units(7) && o.lock),
            'S2 FAIL: maker order should stay locked while the swap is unresolved');

        // The real buyer completes the swap, through the negotiation.
        await negotiate(sessionOf(T), T, M);
        emitSwap(T, sessionOf(T), 'BUYER:STEP6', txidFor(sessionOf(T)));
        await waitFor(() => allHistory().some((h) => h.txid === txidFor(sessionOf(T))), { message: 'real fill recorded' });
        assert.ok(!allHistory().some((h) => h.txid === txidOf('fake-txid')),
            'S2 FAIL: seller-faked BUYER:STEP6 was recorded as a fill');
        console.log('S2c PASS: BUYER:STEP6 only settles from the buyer\'s socket; fake txid rejected');

        M.socket.close();
        T.socket.close();
        await stopServer(server);
        console.log('S2 (TERMINATE spoof): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('S2 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
