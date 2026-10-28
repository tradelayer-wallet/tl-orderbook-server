'use strict';

/*
 * Live connections are capped per address (SocketManager admitConnection). Sockets are not
 * authenticated, and the per-socket limits and the server-wide order cap are shared, so one client
 * that opens enough sockets could take the server-wide budget away from everyone else.
 */
process.env.MAX_CONNECTIONS_PER_IP = '2';

const path = require('path');
const {
    assert, sleep, startServer, stopServer, connectClient, rawSpotOrder, ordersOf, BUILD,
} = require('./common');

const { getConnectedSocket } = require(path.join(BUILD, 'services/socket'));

(async () => {
    const { server, url } = await startServer();
    const clients = [];
    const open = async (name) => {
        const c = await connectClient(url, name);
        clients.push(c);
        return c;
    };
    try {
        // ---- a) the cap admits up to MAX_CONNECTIONS_PER_IP sockets from one address ----
        const a1 = await open('a1');
        const a2 = await open('a2');
        a2.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1 }));
        await sleep(200);
        assert.strictEqual(ordersOf(a2.id).length, 1, 'F2a FAIL: an admitted socket could not place an order');

        // ---- b) a third socket from the same address is refused ------------------------
        const a3 = await open('a3');
        await sleep(300);
        assert.ok(a3.errors.some((e) => /Too many connections from this address/.test(e)),
            `F2b FAIL: a third socket from one address was admitted (errors: ${JSON.stringify(a3.errors)})`);
        assert.strictEqual(getConnectedSocket(a3.id), undefined, 'F2b FAIL: the refused socket is still connected on the server');
        console.log('F2b PASS: a third live socket from one address is refused and disconnected');

        // ---- c) the slot is released when a socket goes away ----------------------------
        a1.socket.close();
        await sleep(300);
        const a4 = await open('a4');
        await sleep(300);
        assert.ok(getConnectedSocket(a4.id) && a4.errors.length === 0,
            `F2c FAIL: a socket was refused after another from the same address closed (errors: ${JSON.stringify(a4.errors)})`);
        console.log('F2c PASS: a closed socket frees its address slot; the connection cap counts live sockets only');
    } finally {
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(1000)]);
    }
    process.exit(0);
})().catch((e) => {
    console.error('F2 FAIL:', e && e.stack || e);
    process.exit(1);
});
