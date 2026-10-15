'use strict';

// Protocol v2 (rounds/r12/protocol-v2.md): integer units on the wire, the step table, the
// terminal states and the signed window. Set before the config module loads.
process.env.SWAP_TIMEOUT_MS = '3000';
process.env.SWAP_SIGNED_WINDOW_MS = '1500';

const {
    assert, sleep, waitFor, startServer, stopServer, connectClient, units,
    eventsOf, ordersOf, allHistory, activeSwapSessions, sessionOf, emitSwap, negotiate,
    sendStep, txidOf,
} = require('./common');

// V2_OLD_WIRE=1 sends the same scenarios with the pre-v2 float amounts, so each v2 assertion can be
// shown failing on the old server for its own reason (see rounds/r12/protocol-v2-report.md).
const OLD_WIRE = !!process.env.V2_OLD_WIRE;
const wire = (human) => (OLD_WIRE ? human : units(human));

const TX = (label) => txidOf(`v2-${label}`);
// The SERVER:STATE notices a client received, as { state, txid }.
const serverStates = (client) => eventsOf(client, 'swap')
    .map((e) => e.args[0])
    .filter((ev) => ev.eventName === 'SERVER:STATE')
    .map((ev) => ev.data);
const sell = (client) => client.socket.emit('new-order', {
    type: 'SPOT', action: 'SELL', isLimitOrder: true, marketName: 'TEST/TEST',
    keypair: { address: `sell-${client.name}`, pubkey: `pk-${client.name}` },
    props: { id_for_sale: 1, id_desired: 2, amount: wire(0.5), price: wire(0.3) },
});
const buy = (client) => client.socket.emit('new-order', {
    type: 'SPOT', action: 'BUY', isLimitOrder: true, marketName: 'TEST/TEST',
    keypair: { address: `buy-${client.name}`, pubkey: `pk-${client.name}` },
    props: { id_for_sale: 2, id_desired: 1, amount: wire(0.5), price: wire(0.3) },
});
const rawSellSpot = (props) => ({
    type: 'SPOT', action: 'SELL', isLimitOrder: true, marketName: 'TEST/TEST',
    keypair: { address: 'raw-a', pubkey: 'raw-pk' }, props: { id_for_sale: 2, id_desired: 1, amount: units(1), price: units(1), ...props },
});

(async () => {
    const failures = [];
    const check = async (name, fn) => {
        try {
            await fn();
        } catch (e) {
            failures.push(name);
            console.log(`V2 ${name} FAIL: ${e.message}`);
        }
    };
    const { server, url } = await startServer();
    const clients = [];
    const connect = async (name) => { const c = await connectClient(url, name); clients.push(c); return c; };
    let M, T, sid;
    try {
        await check('A', async () => {
        const A = await connect('v2-a');
        for (const [props, message] of [
            [{ amount: 1.5 }, 'Order amount must be a positive integer number of units'],
            [{ amount: '100000000' }, 'Order amount must be a positive integer number of units'],
            [{ price: 0.5 }, 'Order price must be a positive integer number of sats per token'],
            [{ price: 1e-8 }, 'Order price must be a positive integer number of sats per token'],
        ]) {
            const before = A.errors.length;
            A.socket.emit('new-order', rawSellSpot(props));
            await waitFor(() => A.errors.length > before, { message: `refusal of ${JSON.stringify(props)}` });
            assert.strictEqual(A.errors[A.errors.length - 1], message, `A: ${JSON.stringify(props)}`);
        }
        assert.strictEqual(ordersOf(A.id).length, 0, 'A: a refused order rested');
        console.log('V2 A PASS: float and string amounts and prices are refused at intake');
        });

        await check('B', async () => {
        M = await connect('v2-maker');
        T = await connect('v2-taker');
        sell(M);
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'B: maker rested' });
        T.socket.emit('update-orderbook', { type: 'SPOT', first_token: 1, second_token: 2 });
        await waitFor(() => eventsOf(T, 'orderbook-data').length > 0, { message: 'B: book view' });
        const shown = eventsOf(T, 'orderbook-data').slice(-1)[0].args[0].orders;
        buy(T);
        await waitFor(() => eventsOf(T, 'new-channel').length === 1, { message: 'B: new-channel' });
        const channel = eventsOf(T, 'new-channel')[0].args[0];
        assert.deepStrictEqual(Object.keys(channel).sort(), ['isBuyer', 'sessionId', 'tradeInfo'],
            `B: new-channel carries fields outside the v2 schema: ${Object.keys(channel)}`);
        assert.deepStrictEqual(channel.tradeInfo.props, {
            propIdDesired: 1, propIdForSale: 2, amountDesired: wire(0.5), amountForSale: units(0.15), price: wire(0.3),
        }, 'B: spot trade props');
        assert.ok(shown.length === 1 && Number.isSafeInteger(shown[0].props.amount) && shown[0].props.amount === wire(0.5),
            `B: order amount on the wire is not integer units: ${JSON.stringify(shown[0] && shown[0].props)}`);
        assert.ok(Number.isSafeInteger(shown[0].props.price) && shown[0].props.price === wire(0.3), 'B: price is sats per token');
        console.log('V2 B PASS: book, new-channel and trade props are integer units; new-channel has no unfilled');
        });

        await check('C', async () => {
        sid = sessionOf(T);
        emitSwap(T, sid, 'BUYER:STEP6', TX('early'));                    // buyer before any step
        await waitFor(() => T.errors.some((e) => /BUYER:STEP6 is not the next step/.test(e)), { message: 'C: early STEP6' });
        emitSwap(M, sid, 'SELLER:STEP1', { address: 'x' });               // schema: missing fields
        await waitFor(() => M.errors.some((e) => /SELLER:STEP1 data does not match its schema/.test(e)), { message: 'C: bad STEP1' });
        assert.ok(!eventsOf(T, 'swap').some((e) => e.args[0].eventName === 'SELLER:STEP1'), 'C: a bad step was relayed');
        assert.strictEqual(ordersOf(M.id)[0].lock, true, 'C: the maker is locked while the swap runs');
        console.log('V2 C PASS: out-of-step and mis-shaped swap events are refused and nothing is relayed');
        });

        await check('D', async () => {
        await negotiate(sid, T, M);
        emitSwap(T, sid, 'TERMINATE_TRADE', 'too late');
        await waitFor(() => T.errors.some((e) => /TERMINATE_TRADE is refused after SELLER:STEP5/.test(e)), { message: 'D: refusal' });
        assert.strictEqual(activeSwapSessions(), 1, 'D: a refused TERMINATE ended the session');
        assert.strictEqual(ordersOf(M.id)[0].lock, true, 'D: the maker was unlocked after the signed step');
        await waitFor(() => serverStates(T).some((s) => s.state === 'expired-unverified'),
            { timeout: 4000, message: 'D: expired-unverified notice' });
        assert.deepStrictEqual(serverStates(M).map((s) => s.state), ['expired-unverified'], 'D: seller notice');
        assert.strictEqual(serverStates(T)[0].txid, null, 'D: no txid is reported for an unverified outcome');
        assert.strictEqual(ordersOf(M.id)[0].lock, false, 'D: the maker stays unlocked after the window');
        assert.strictEqual(activeSwapSessions(), 0, 'D: the session is gone');
        assert.ok(!allHistory().some((h) => h.txid === TX('early')), 'D: an unverified swap recorded a trade');
        emitSwap(T, sid, 'BUYER:STEP6', TX('late'));
        await waitFor(() => T.errors.some((e) => /unknown or foreign sessionId/.test(e)), { message: 'D: late report refused' });
        // The unverified maker is matchable again (the bounded residual risk): take it off the book.
        M.socket.emit('close-order', ordersOf(M.id)[0].uuid);
        await waitFor(() => ordersOf(M.id).length === 0, { message: 'D: maker cancelled' });
        console.log('V2 D PASS: TERMINATE after SELLER:STEP5 is refused; the window ends expired-unverified, nothing recorded');
        });

        await check('E', async () => {
        const M2 = await connect('v2-maker2');
        const T2 = await connect('v2-taker2');
        sell(M2);
        await waitFor(() => ordersOf(M2.id).length === 1, { message: 'E: maker2 rested' });
        buy(T2);
        await waitFor(() => eventsOf(T2, 'new-channel').length === 1, { message: 'E: channel2' });
        const sid2 = sessionOf(T2);
        await negotiate(sid2, T2, M2);
        await sleep(300);
        emitSwap(T2, sid2, 'BUYER:STEP6', TX('settled'));
        await waitFor(() => serverStates(T2).some((s) => s.state === 'settled'), { message: 'E: settled notice (buyer)' });
        await waitFor(() => serverStates(M2).some((s) => s.state === 'settled'), { message: 'E: settled notice (seller)' });
        assert.strictEqual(serverStates(M2).find((s) => s.state === 'settled').txid, TX('settled'), 'E: settled notice txid');
        assert.ok(ordersOf(M2.id).length === 0, 'E: the fully filled maker is removed');
        const trade = allHistory().find((h) => h.txid === TX('settled'));
        assert.ok(trade && trade.props.price === wire(0.3) && trade.props.amountForSale === units(0.15), 'E: trade record');
        console.log('V2 E PASS: a report inside the signed window settles the trade, both sides are told, the maker is consumed');
        });

        await check('F', async () => {
        const M3 = await connect('v2-maker3');
        const T3 = await connect('v2-taker3');
        sell(M3);
        await waitFor(() => ordersOf(M3.id).length === 1, { message: 'F: maker3 rested' });
        buy(T3);
        await waitFor(() => eventsOf(T3, 'new-channel').length === 1, { message: 'F: channel3' });
        await waitFor(() => serverStates(T3).some((s) => s.state === 'aborted') && serverStates(M3).some((s) => s.state === 'aborted'),
            { timeout: 5000, message: 'F: aborted notices' });
        assert.strictEqual(ordersOf(M3.id)[0].lock, false, 'F: the maker is unlocked after a negotiation timeout');
        assert.ok(T3.errors.some((e) => /timed out/.test(e)), 'F: the buyer sees the timeout');
        M3.socket.emit('close-order', ordersOf(M3.id)[0].uuid);
        await waitFor(() => ordersOf(M3.id).length === 0, { message: 'F: maker3 cancelled' });
        console.log('V2 F PASS: a negotiation timeout ends aborted, both sides are told, the maker is unlocked');
        });

        await check('G', async () => {
        const M4 = await connect('v2-maker4');
        const T4 = await connect('v2-taker4');
        sell(M4);
        await waitFor(() => ordersOf(M4.id).length === 1, { message: 'G: maker4 rested' });
        buy(T4);
        await waitFor(() => eventsOf(T4, 'new-channel').length === 1, { message: 'G: channel4' });
        const sid4 = sessionOf(T4);
        await sendStep(sid4, T4, M4, 0);
        emitSwap(T4, sid4, 'TERMINATE_TRADE', 'no keys for me');
        await waitFor(() => serverStates(M4).some((s) => s.state === 'aborted'), { message: 'G: aborted notice' });
        const relayed = eventsOf(M4, 'swap').map((e) => e.args[0]).find((ev) => ev.eventName === 'TERMINATE_TRADE');
        assert.ok(relayed && relayed.data === 'no keys for me' && relayed.socketId === T4.id, 'G: the terminate relay');
        assert.strictEqual(ordersOf(M4.id)[0].lock, false, 'G: maker unlocked');
        console.log('V2 G PASS: TERMINATE before signing aborts, the reason is relayed, the maker is unlocked');
        });

        for (const c of clients) c.socket.close();
        await stopServer(server);
        if (failures.length) {
            console.log(`V2 (protocol v2): ${failures.length} section(s) failed: ${failures.join(', ')}`);
            process.exit(1);
        }
        console.log('V2 (protocol v2): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('V2 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
