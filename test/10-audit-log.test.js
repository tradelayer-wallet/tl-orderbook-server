'use strict';

/*
 * N2 (round 2) — audit-log state must follow the outcome of the operation.
 *
 * Proven bug (f7f1b28): OrderbookManager.removeOrder wrote the CANCALED state
 * to the ORDER log unconditionally, so a close-order from a NON-owner was
 * rejected by the book ("Not Authorized") but still tampered the audit log.
 *
 * Expected (post-fix):
 *  a) non-owner close-order -> order stays on the book, log has NO CANCALED entry
 *  b) owner close-order     -> order removed, log records CANCALED
 */
const fs = require('fs');
const path = require('path');
const {
    assert, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, ordersOf, workDir,
} = require('./common');

// All ORDER-log lines for one order uuid, as [{ file, state }].
const orderLogEntries = (uuid) => {
    const dir = path.join(workDir, 'logs');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('ORDER')) continue;
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            if (!line) continue;
            const o = JSON.parse(line);
            if (o.uuid === uuid) out.push({ file: f, state: o.state || null });
        }
    }
    return out;
};

(async () => {
    const { server, url } = await startServer();
    try {
        const V = await connectClient(url, 'victim-owner');
        const A = await connectClient(url, 'attacker');

        V.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 9, id_for_sale: 6, id_desired: 5, keypair: { address: 'n2-v', pubkey: 'n2-v' } }));
        await waitFor(() => ordersOf(V.id).length === 1, { message: 'owner order rested' });
        const uuid = ordersOf(V.id)[0].uuid;
        await waitFor(() => orderLogEntries(uuid).length === 1, { message: 'ORDER log line written' });

        // ---- a) non-owner close-order ------------------------------------
        const before = eventsOf(A, 'placed-orders').length;
        A.socket.emit('close-order', uuid);
        await waitFor(() => eventsOf(A, 'placed-orders').length > before, { message: 'attacker close-order handled' });

        assert.strictEqual(ordersOf(V.id).length, 1, 'N2 FAIL: non-owner close-order removed the owner\'s order');
        const tampered = orderLogEntries(uuid).filter((e) => e.state === 'CANCALED');
        assert.strictEqual(tampered.length, 0,
            `N2 FAIL: rejected non-owner close-order wrote CANCALED to the audit log (${JSON.stringify(tampered)})`);
        console.log('N2a PASS: rejected close-order by a non-owner leaves the audit log untouched');

        // ---- b) owner close-order records the cancel ----------------------
        const beforeOwner = eventsOf(V, 'placed-orders').length;
        V.socket.emit('close-order', uuid);
        await waitFor(() => eventsOf(V, 'placed-orders').length > beforeOwner, { message: 'owner close-order handled' });
        await waitFor(() => ordersOf(V.id).length === 0, { message: 'owner order removed' });
        await waitFor(() => orderLogEntries(uuid).some((e) => e.state === 'CANCALED'),
            { message: 'CANCALED written for owner close' });
        console.log('N2b PASS: owner close-order removes the order and records CANCALED');

        V.socket.close();
        A.socket.close();
        await stopServer(server);
        console.log('N2 (audit log): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('N2 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
