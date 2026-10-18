'use strict';

/*
 * A taker is matched with the best settleable crossing order that belongs to another account
 * (orderbook checkMatch). Its own resting order at the best price is skipped, not an error, so a
 * counterparty at a worse crossing price still trades. A taker is refused as a self-match only when
 * every settleable crossing order is its own.
 */

const {
    assert, waitFor, startServer, stopServer, connectClient, rawSpotOrder, ordersOf, eventsOf, sleep,
} = require('./common');

// Each sell and buy is placed by a socket and waits until it rests (or the swap channel opens).
const rest = async (client, props) => {
    client.socket.emit('new-order', rawSpotOrder(props));
    await waitFor(() => ordersOf(client.id).some((o) => o.props.price === props.price * 1e8), { message: `${client.name} rested` });
};

(async () => {
    const { server, url } = await startServer();
    const clients = [];
    const open = async (name) => {
        const c = await connectClient(url, name);
        clients.push(c);
        return c;
    };
    try {
        // ---- a) the best crossing order is the taker's own; another seller settles at a worse price
        {
            const X = await open('x');
            const Y = await open('y');
            const xAddr = { address: 'x-addr', pubkey: 'x-pk' };
            await rest(X, { action: 'SELL', amount: 1, price: 1, id_for_sale: 1, id_desired: 2, keypair: xAddr });
            await rest(Y, { action: 'SELL', amount: 1, price: 2, id_for_sale: 1, id_desired: 2, keypair: { address: 'y-addr', pubkey: 'y-pk' } });
            X.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 2, id_for_sale: 2, id_desired: 1, keypair: xAddr }));
            await waitFor(() => eventsOf(X, 'new-channel').length === 1 || X.errors.length > 0, { message: 'a: X answered' });
            assert.deepStrictEqual(X.errors, [], `F3a FAIL: taker refused: ${X.errors.join('; ')}`);
            assert.strictEqual(eventsOf(X, 'new-channel')[0].args[0].tradeInfo.seller.socketId, Y.id,
                'F3a FAIL: the taker was matched with a counterparty other than the other seller');
            console.log('F3a PASS: a taker whose own order is the best price trades with the next settleable seller');
        }

        // ---- b) the only settleable crossing order is the taker's own: still refused
        {
            const Z = await open('z');
            const zAddr = { address: 'z-addr', pubkey: 'z-pk' };
            await rest(Z, { action: 'SELL', amount: 1, price: 5, id_for_sale: 3, id_desired: 4, keypair: zAddr });
            Z.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 5, id_for_sale: 4, id_desired: 3, keypair: zAddr }));
            await waitFor(() => Z.errors.length > 0, { message: 'b: self-match answered' });
            assert.match(String(Z.errors[0]), /same Account/, `F3b FAIL: self-match refusal is "${Z.errors[0]}"`);
            assert.strictEqual(eventsOf(Z, 'new-channel').length, 0, 'F3b FAIL: a self-match opened a swap channel');
            console.log('F3b PASS: a taker whose only settleable crossing order is its own is refused as a same-account match');
        }

        // ---- c) the best crossing order is from the same address on another socket
        {
            const W1 = await open('w1');
            const V = await open('v');
            const W2 = await open('w2');
            const wAddr = { address: 'w-addr', pubkey: 'w-pk' };
            await rest(W1, { action: 'SELL', amount: 1, price: 1, id_for_sale: 5, id_desired: 6, keypair: wAddr });
            await rest(V, { action: 'SELL', amount: 1, price: 2, id_for_sale: 5, id_desired: 6, keypair: { address: 'v-addr', pubkey: 'v-pk' } });
            W2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 2, id_for_sale: 6, id_desired: 5, keypair: wAddr }));
            await waitFor(() => eventsOf(W2, 'new-channel').length === 1 || W2.errors.length > 0, { message: 'c: W2 answered' });
            assert.deepStrictEqual(W2.errors, [], `F3c FAIL: same-address taker refused: ${W2.errors.join('; ')}`);
            assert.strictEqual(eventsOf(W2, 'new-channel')[0].args[0].tradeInfo.seller.socketId, V.id,
                'F3c FAIL: the same-address taker was not matched with the other seller');
            console.log('F3c PASS: same-address crossing orders are skipped the same way as same-account ones');
        }
    } finally {
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(1000)]);
    }
    process.exit(0);
})().catch((e) => {
    console.error('F3 FAIL:', e && e.stack || e);
    process.exit(1);
});
