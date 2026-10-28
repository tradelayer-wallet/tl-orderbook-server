'use strict';

/*
 * The order history restored from today's and yesterday's ORDER logs at start-up holds protocol v2
 * records only. A record written before v2 (float amounts and price) is not restored, so it is never
 * sent to a client in placed-orders (protocol-v2.md N5).
 */
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { assert, startServer, stopServer, BUILD, sleep } = require('./common');

const orderbookMod = require(path.join(BUILD, 'services/orderbook'));

const logsDir = path.join(process.cwd(), 'logs');
const TODAY = moment().format('DD-MM-YYYY');
const order = (uuid, props) => ({
    type: 'SPOT',
    action: 'SELL',
    isLimitOrder: true,
    marketName: 'TEST/TEST',
    keypair: { address: 'restore-addr', pubkey: 'restore-pk' },
    props: { id_for_sale: 2, id_desired: 1, ...props },
    timestamp: 1,
    uuid,
    socket_id: 'old-socket',
    lock: false,
});

fs.writeFileSync(path.join(logsDir, `ORDER-spot_2_1-${TODAY}.log`), [
    JSON.stringify(order('f5-legacy-float', { amount: 0.5, price: 0.3 })),
    JSON.stringify(order('f5-v2-units', { amount: 50000000, price: 30000000 })),
].join('\n') + '\n');

(async () => {
    const { server } = await startServer();
    try {
        const restored = orderbookMod.orderbookManager.getOrdersHistory().map((o) => o.uuid);
        assert.ok(!restored.includes('f5-legacy-float'),
            'F5a FAIL: a pre-v2 ORDER record (float amount and price) was restored into the order history');
        assert.ok(restored.includes('f5-v2-units'), 'F5a FAIL: a v2 ORDER record was not restored');
        console.log('F5a PASS: only v2 ORDER records are restored into the order history');
    } finally {
        await Promise.race([stopServer(server), sleep(1000)]);
    }
    process.exit(0);
})().catch((e) => {
    console.error('F5 FAIL:', e && e.stack || e);
    process.exit(1);
});
