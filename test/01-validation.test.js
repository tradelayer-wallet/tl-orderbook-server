'use strict';

/*
 * Earlier-PR regression: input validation / mass-assignment / path traversal.
 *  - invalid amounts, prices, ids, market orders -> order:error
 *  - raw client JSON cannot mass-assign uuid/socket_id/lock/timestamp
 *  - log file names stay inside logs/ with sanitized names
 */
const fs = require('fs');
const path = require('path');
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, ordersOf, mixPure,
} = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        const V = await connectClient(url, 'validator');

        const expectError = async (raw, includes) => {
            const before = V.errors.length;
            V.socket.emit('new-order', raw);
            await waitFor(() => V.errors.length > before, { message: `order:error (${includes})` });
            assert.ok(V.errors[V.errors.length - 1].includes(includes),
                `expected error containing "${includes}", got: ${V.errors[V.errors.length - 1]}`);
        };

        await expectError(rawSpotOrder({ props: { id_for_sale: 2, id_desired: 1, amount: -5, price: 1 } }),
            'Order amount must be a positive integer number of units');
        await expectError(rawSpotOrder({ props: { id_for_sale: 2, id_desired: 1, amount: 1, price: 0 } }),
            'Order price must be a positive integer number of sats per token');
        await expectError(rawSpotOrder({ props: { id_for_sale: '../../etc/passwd', id_desired: 1, amount: 1, price: 1 } }),
            'Invalid id_for_sale');
        await expectError(rawSpotOrder({ props: { id_for_sale: 2, id_desired: 's-1-5; rm -rf /', amount: 1, price: 1 } }),
            'Invalid id_desired');
        await expectError(rawSpotOrder({ isLimitOrder: false }), 'Only limit orders are allowed');
        await expectError(rawSpotOrder({ keypair: null }), 'Invalid keypair');
        console.log('VALIDATION PASS: malformed / traversal orders rejected with order:error');

        // whitelisted synthetic id still accepted (markets service uses it)
        V.socket.emit('new-order', rawSpotOrder({ action: 'SELL', props: { id_for_sale: 's-1-5', id_desired: 3, amount: 1, price: 1 }, keypair: { address: 'addr-wl', pubkey: 'pk-wl' } }));
        await waitFor(() => eventsOf(V, 'order:saved').length === 1, { message: 'whitelisted id accepted' });

        // mass assignment: server-assigned fields must win
        V.socket.emit('new-order', rawSpotOrder({
            action: 'SELL',
            props: { id_for_sale: 9, id_desired: 10, amount: 1, price: 1 },
            keypair: { address: 'addr-ma', pubkey: 'pk-ma' },
            uuid: 'attacker-uuid',
            socket_id: 'someone-elses-socket',
            lock: true,
            timestamp: 1,
            evil: 'payload',
        }));
        await waitFor(() => eventsOf(V, 'order:saved').length === 2, { message: 'mass-assignment order saved' });
        const order = ordersOf(V.id).find((o) => o.props.id_for_sale === 9);
        assert.ok(order, 'order missing after mass-assignment attempt');
        assert.notStrictEqual(order.uuid, 'attacker-uuid', 'client-controlled uuid accepted');
        assert.strictEqual(order.socket_id, V.id, 'client-controlled socket_id accepted');
        assert.strictEqual(order.lock, false, 'client-controlled lock accepted');
        assert.ok(order.timestamp > 1000, 'client-controlled timestamp accepted');
        assert.strictEqual(order.evil, undefined, 'unknown client field leaked into order');
        console.log('VALIDATION PASS: no mass-assignment (uuid/socket_id/lock/timestamp server-assigned)');

        // log name containment
        await sleep(300); // let earlier async appendFile calls land
        const logsDir = path.join(process.cwd(), 'logs');
        const before = fs.readdirSync(logsDir).length;
        mixPure.saveLog('../../evil-name', 'ORDER', { uuid: 'x' });
        await sleep(100);
        const files = fs.readdirSync(logsDir);
        assert.ok(files.length === before + 1, 'saveLog should create exactly one file');
        const created = files.find((f) => f.includes('evil-name'));
        assert.ok(created, 'sanitized log file missing');
        assert.ok(created.indexOf('/') === -1 && created.indexOf('\\') === -1, 'log file name not sanitized');
        assert.ok(!fs.existsSync(path.join(process.cwd(), 'evil-name'))
            && !fs.existsSync(path.resolve(process.cwd(), '..', 'evil-name')), 'log escaped logs/ directory');
        const escaped = fs.readdirSync(path.dirname(logsDir));
        assert.deepStrictEqual(escaped.sort(), ['logs'], `unexpected files outside logs/: ${escaped}`);
        console.log('VALIDATION PASS: saveLog stays inside logs/ with a sanitized name');

        V.socket.close();
        await stopServer(server);
        console.log('VALIDATION: ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('VALIDATION FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
