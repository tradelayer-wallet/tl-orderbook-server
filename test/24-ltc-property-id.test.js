'use strict';

/*
 * LTC is property id 0: the id the markets list gives LTC, and the TradeLayer consensus id of LTC. A
 * wallet places an LTC-for-token order with id 0, so the book must accept it, match it, and report the
 * trade with id 0 to both sides. -1 is not a property id, so the book refuses it. Both cases go through
 * the real order factory (protocol/messages) and the socket server.
 */

const path = require('path');
const {
    assert, startServer, stopServer, connectClient, eventsOf, ordersOf, waitFor, units, BUILD,
} = require('./common');
const { parseNewOrder } = require(path.join(BUILD, 'protocol/messages'));

const LTC = 0;
const TOKEN = 1;

// The order a wallet sends for the TL/LTC market: BUY pays LTC (id_for_sale 0) for TL (id_desired 1).
const walletOrder = (action, who, props = {}) => ({
    type: 'SPOT',
    action,
    isLimitOrder: true,
    marketName: 'TL/LTC',
    keypair: { address: `addr-${who}`, pubkey: `pk-${who}` },
    props: {
        id_for_sale: action === 'BUY' ? LTC : TOKEN,
        id_desired: action === 'BUY' ? TOKEN : LTC,
        amount: units(1),
        price: units(0.3),
        ...props,
    },
});

(async () => {
    const { server, url } = await startServer();
    try {
        const factory = parseNewOrder(walletOrder('BUY', 'factory'), 'sock-factory');
        assert.ok(factory.data, `factory refused an LTC-for-token order: ${factory.error}`);
        assert.strictEqual(factory.data.props.id_for_sale, LTC, 'the factory changed the LTC id');

        const bad = parseNewOrder(walletOrder('BUY', 'factory', { id_for_sale: -1 }), 'sock-factory');
        assert.strictEqual(bad.error, 'Invalid id_for_sale', 'the factory accepted -1 as a property id');
        console.log('LTC-ID PASS: the order factory takes id 0 for LTC and refuses -1');

        const M = await connectClient(url, 'ltc-maker');
        const T = await connectClient(url, 'ltc-taker');

        M.socket.emit('new-order', walletOrder('SELL', 'maker'));
        await waitFor(() => ordersOf(M.id).length === 1, { message: 'maker order on the book' });

        T.socket.emit('new-order', walletOrder('BUY', 'taker'));
        await waitFor(() => eventsOf(T, 'new-channel').length === 1 && eventsOf(M, 'new-channel').length === 1,
            { message: 'swap channel for both sides' });
        for (const client of [T, M]) {
            const { tradeInfo } = eventsOf(client, 'new-channel')[0].args[0];
            assert.strictEqual(tradeInfo.props.propIdForSale, LTC, `${client.name}: LTC leg reported with another id`);
            assert.strictEqual(tradeInfo.props.propIdDesired, TOKEN, `${client.name}: token leg reported with another id`);
            assert.strictEqual(tradeInfo.props.amountForSale, units(0.3), `${client.name}: LTC amount in satoshis`);
        }
        console.log('LTC-ID PASS: an LTC-for-token trade is matched and reported with id 0 to both sides');

        const before = T.errors.length;
        T.socket.emit('new-order', walletOrder('BUY', 'taker-2', { id_for_sale: -1 }));
        await waitFor(() => T.errors.length > before, { message: 'refusal of id -1' });
        assert.strictEqual(T.errors[T.errors.length - 1], 'Invalid id_for_sale');
        assert.strictEqual(ordersOf(T.id).length, 0, 'a refused order rested');
        console.log('LTC-ID PASS: the socket refuses id -1 for id_for_sale');

        M.socket.close();
        T.socket.close();
        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error('LTC-ID FAIL:', e.message);
        process.exit(1);
    }
})();
