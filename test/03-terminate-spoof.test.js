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
 *  b) owner terminate   -> maker's order stays on the book, unlocked; only the
 *     owner's close-order removes it. (The original semantics removed it, but the
 *     maker's wallet terminates on its own when it refuses a step or times out, so
 *     a taker could delete any order it matched.)
 *  d) a taker sends a junk step; the maker's wallet terminates -> the order stays,
 *     unlocked, and the next taker matches it
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

        // ---- b) owner terminate unlocks the order; close-order cancels it ---
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 2, price: 5, id_for_sale: 4, id_desired: 3, keypair: { address: 'addr-m2', pubkey: 'pk-m2' } }));
        await waitFor(() => ordersOf(M.id).length === 2, { message: 'second maker order on book' });
        const maker2 = ordersOf(M.id).find((o) => o.props.price === units(5));

        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 2, price: 5, id_for_sale: 3, id_desired: 4, keypair: { address: 'addr-t2', pubkey: 'pk-t2' } }));
        await waitFor(() => eventsOf(M, 'new-channel').length === 2, { message: 'second swap channel opened' });

        // The maker (owner of the resting order) terminates on its own channel.
        emitSwap(M, sessionOf(M), 'TERMINATE_TRADE', 'owner abort');
        await waitFor(() => ordersOf(M.id).some((o) => o.uuid === maker2.uuid && o.lock === false),
            { message: 'owner terminate unlocks the maker order' });
        await sleep(300);
        assert.strictEqual(ordersOf(M.id).length, 2,
            `S2 FAIL: owner terminate removed an order (orders now: ${JSON.stringify(ordersOf(M.id))})`);
        M.socket.emit('close-order', maker2.uuid);
        await waitFor(() => !ordersOf(M.id).some((o) => o.uuid === maker2.uuid), { message: 'owner close-order removes the order' });
        assert.ok(ordersOf(M.id).some((o) => o.uuid === makerUuid),
            'S2 FAIL: close-order removed an unrelated order');
        console.log('S2b PASS: owner TERMINATE unlocks the order; the owner\'s close-order removes it');


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

        // ---- d) a taker cannot make the maker's wallet delete the order ----
        // The wallet's SellSwapper refuses a malformed SELLER:STEP1 and sends TERMINATE_TRADE
        // itself (swap.ts, seller.ts). That terminate comes from the maker's own socket.
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 9, id_for_sale: 8, id_desired: 7, keypair: { address: 'addr-m4', pubkey: 'pk-m4' } }));
        await waitFor(() => ordersOf(M.id).some((o) => o.props.price === units(9)), { message: 'fourth maker order on book' });
        const maker4 = ordersOf(M.id).find((o) => o.props.price === units(9));
        const channelsBefore = eventsOf(M, 'new-channel').length;
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 9, id_for_sale: 7, id_desired: 8, keypair: { address: 'addr-t4', pubkey: 'pk-t4' } }));
        await waitFor(() => eventsOf(M, 'new-channel').length === channelsBefore + 1, { message: 'fourth swap channel opened' });
        emitSwap(M, sessionOf(M), 'TERMINATE_TRADE', 'refused: malformed SELLER:STEP1');
        await waitFor(() => ordersOf(M.id).some((o) => o.uuid === maker4.uuid && o.lock === false),
            { message: 'the maker order is unlocked after its wallet terminated' });
        const T2 = await connectClient(url, 'taker-2');
        T2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 9, id_for_sale: 7, id_desired: 8, keypair: { address: 'addr-t5', pubkey: 'pk-t5' } }));
        await waitFor(() => eventsOf(M, 'new-channel').length === channelsBefore + 2,
            { message: 'the next taker matches the order the first taker could not delete' });
        console.log('S2d PASS: a taker that makes the maker\'s wallet terminate cannot delete the order; the next taker matches it');
        emitSwap(M, sessionOf(M), 'TERMINATE_TRADE', 'test cleanup');
        await waitFor(() => ordersOf(M.id).some((o) => o.uuid === maker4.uuid && o.lock === false), { message: 'fourth order unlocked again' });
        M.socket.emit('close-order', maker4.uuid);
        await waitFor(() => !ordersOf(M.id).some((o) => o.uuid === maker4.uuid), { message: 'fourth order closed' });
        T2.socket.close();

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
