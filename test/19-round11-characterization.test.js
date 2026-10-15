'use strict';

/*
 * Round 11 characterization — pins the current behaviour of every caller of the rules that
 * this round unifies (intake validation, settlement arithmetic, placed-orders payloads,
 * batch rate limiting). These expectations describe what clients receive today and must
 * still hold after the duplicated rules are collapsed into one function each.
 */
const {
    assert, waitFor, waitForEvent, startServer, stopServer, connectClient,
    rawSpotOrder, ordersOf, allHistory, sessionOf, eventsOf, units, settleSwap,
} = require('./common');

const TXID = 'ab'.repeat(32);

const rawFuturesOrder = ({ props = {}, ...over } = {}) => ({
    type: 'FUTURES',
    action: 'BUY',
    isLimitOrder: true,
    marketName: 'TL/USDT',
    keypair: { address: `f-${Math.random()}`, pubkey: 'fpk' },
    ...over,
    props: { contract_id: 4, amount: units(1), price: units(1), levarage: 2, collateral: 1, ...props },
});

(async () => {
    const { server, url } = await startServer();
    try {
        const C = await connectClient(url, 'r11-char');
        const errorCount = () => C.errors.length;
        const expectError = async (raw, message, event = 'new-order') => {
            const before = errorCount();
            C.socket.emit(event, raw);
            await waitFor(() => errorCount() > before, { message: `error for ${message}` });
            assert.strictEqual(C.errors[C.errors.length - 1], message);
        };

        // ---- intake: single new-order path -----------------------------------------
        await expectError(rawSpotOrder({ props: { amount: -5 } }), 'Order amount must be a positive integer number of units');
        await expectError(rawSpotOrder({ props: { amount: units(0) } }), 'Order amount must be a positive integer number of units');
        await expectError(rawSpotOrder({ props: { amount: 1.5 } }), 'Order amount must be a positive integer number of units');
        await expectError(rawSpotOrder({ props: { amount: '100000000' } }), 'Order amount must be a positive integer number of units');
        await expectError(rawSpotOrder({ props: { price: units(0) } }), 'Order price must be a positive integer number of sats per token');
        await expectError(rawSpotOrder({ props: { price: 0.5 } }), 'Order price must be a positive integer number of sats per token');
        await expectError(rawSpotOrder({ props: { id_for_sale: -1 } }), 'Invalid id_for_sale');
        await expectError(rawSpotOrder({ props: { id_desired: 1.5 } }), 'Invalid id_desired');
        await expectError(rawSpotOrder({ isLimitOrder: false }), 'Only limit orders are allowed');
        await expectError(rawSpotOrder({ type: 'MARKET' }), 'Invalid order type');
        await expectError(rawSpotOrder({ action: 'HOLD' }), 'Invalid order action');
        await expectError(rawSpotOrder({ marketName: '' }), 'Invalid marketName');
        await expectError(rawSpotOrder({ keypair: { address: 'a', pubkey: '' } }), 'Invalid keypair.pubkey');
        await expectError(rawFuturesOrder({ props: { contract_id: -1 } }), 'Invalid contract_id');
        await expectError(rawFuturesOrder({ props: { levarage: 0 } }), 'Order levarage must be a positive integer');
        await expectError(rawFuturesOrder({ props: { collateral: -1 } }), 'Invalid collateral');
        console.log('R11 CHAR PASS: intake messages for the single new-order path');

        // ---- intake: many-orders path reports its own refusals per entry -----------
        const manyBefore = errorCount();
        C.socket.emit('many-orders', [
            rawSpotOrder({ isLimitOrder: false }),
            rawSpotOrder({ action: 'SELL', props: { amount: units(0.5), price: units(2), id_for_sale: 1, id_desired: 2 } }),
        ]);
        await waitFor(() => eventsOf(C, 'order:saved').length >= 1, { message: 'many-orders saved' });
        assert.strictEqual(C.errors[manyBefore], 'Only limit orders are allowed');
        assert.strictEqual(C.errors.length, manyBefore + 1, 'many-orders: exactly one refusal');
        await waitFor(() => ordersOf(C.id).some((o) => o.props.amount === units(0.5)), { message: 'many-orders entry rested' });
        console.log('R11 CHAR PASS: many-orders per-entry refusal and SAVED marker');

        // ---- placed-orders payload shape on new-order and close-order ----------------
        const placedBefore = eventsOf(C, 'placed-orders').length;
        C.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { amount: units(0.25), price: units(1), id_for_sale: 3, id_desired: 4 } }));
        await waitFor(() => eventsOf(C, 'placed-orders').length > placedBefore, { message: 'placed-orders on new-order' });
        const placed = eventsOf(C, 'placed-orders').slice(-1)[0].args[0];
        assert.deepStrictEqual(Object.keys(placed).sort(), ['openedOrders', 'orderHistory']);
        assert.ok(Array.isArray(placed.openedOrders) && Array.isArray(placed.orderHistory));
        const resting = ordersOf(C.id).find((o) => o.props.amount === units(0.25));
        const closeBefore = eventsOf(C, 'placed-orders').length;
        C.socket.emit('close-order', resting.uuid);
        await waitFor(() => eventsOf(C, 'placed-orders').length > closeBefore, { message: 'placed-orders on close-order' });
        const afterClose = eventsOf(C, 'placed-orders').slice(-1)[0].args[0];
        assert.ok(!afterClose.openedOrders.some((o) => o.uuid === resting.uuid), 'cancelled order still listed');
        assert.ok(afterClose.orderHistory.some((o) => o.uuid === resting.uuid && o.state === 'CANCALED'),
            'cancelled order not marked CANCALED in history');
        console.log('R11 CHAR PASS: placed-orders payload and CANCALED history state');

        // ---- settlement arithmetic: a known trade -----------------------------------
        // Maker SELL 1 at 0.3 (sells id 1 for id 2); taker BUY 0.5 at 0.3 (id_for_sale 2, id_desired 1).
        const M = await connectClient(url, 'r11-maker');
        const T = await connectClient(url, 'r11-taker');
        M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 1, id_desired: 2, amount: units(1), price: units(0.3) } }));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'maker rested' });
        const historyBefore = allHistory().length;
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 2, id_desired: 1, amount: units(0.5), price: units(0.3) } }));
        await waitForEvent(T, 'new-channel', () => true, { message: 'taker new-channel' });
        const sid = sessionOf(T);
        await settleSwap(sid, T, M, TXID);
        await waitFor(() => allHistory().length === historyBefore + 1, { message: 'trade recorded' });
        const trade = allHistory()[0];
        assert.strictEqual(trade.txid, TXID);
        assert.strictEqual(trade.props.amountDesired, units(0.5), 'amountDesired');
        assert.strictEqual(trade.props.amountForSale, units(0.15), 'amountForSale = 0.5 * 0.3, in sats');
        assert.strictEqual(trade.props.price, units(0.3), 'price in sats per token');
        assert.strictEqual(trade.props.propIdDesired, 1);
        assert.strictEqual(trade.props.propIdForSale, 2);
        const makerLeft = ordersOf(M.id);
        assert.strictEqual(makerLeft.length, 1, 'maker remainder still rests');
        assert.strictEqual(makerLeft[0].props.amount, units(0.5), 'maker remainder amount');
        assert.strictEqual(makerLeft[0].lock, false, 'maker remainder unlocked');
        console.log('R11 CHAR PASS: partial fill settles 0.5 at 0.3 for 0.15, remainder 0.5');

        // ---- a trade whose value is not a whole number of satoshis is refused -------
        const dust = await connectClient(url, 'r11-dust');
        dust.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 1, id_desired: 2, amount: units(0.00000001), price: units(0.00000001) } }));
        await waitFor(() => ordersOf(dust.id).length === 1, { message: 'dust maker rested' });
        const refusedBefore = T.errors.length;
        T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', props: { id_for_sale: 2, id_desired: 1, amount: units(0.00000001), price: units(0.00000001) } }));
        await waitFor(() => T.errors.length > refusedBefore, { message: 'sub-satoshi taker refused' });
        assert.strictEqual(T.errors[T.errors.length - 1], 'Trade value is not a whole number of satoshis: the match is refused');
        assert.strictEqual(ordersOf(dust.id)[0].lock, false, 'dust maker left unlocked by a refused match');
        assert.strictEqual(ordersOf(dust.id)[0].props.amount, 1, 'dust maker untouched by a refused match');
        console.log('R11 CHAR PASS: sub-satoshi trade refused, maker untouched');

        // ---- a smallest-unit order is accepted when it rests -----------------------
        const minBefore = eventsOf(T, 'order:saved').length;
        T.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 5, id_desired: 6, amount: units(0.00000001), price: units(0.00000001) } }));
        await waitFor(() => eventsOf(T, 'order:saved').length > minBefore, { message: 'smallest unit rests' });
        console.log('R11 CHAR PASS: smallest unit order rests');

        for (const c of [C, M, T, dust]) c.socket.close();
        await stopServer(server);
        console.log('R11 CHAR: ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('R11 CHAR FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
