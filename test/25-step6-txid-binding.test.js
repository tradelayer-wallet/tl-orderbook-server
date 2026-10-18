'use strict';

/*
 * BUYER:STEP6 settles a swap only with the txid of the transaction the seller signed (protocol-v2.md
 * B.4). The server takes that txid from the PSBT of SELLER:STEP5. A well-formed txid that is not that
 * transaction is refused, the session stays signed, and the buyer may still report the right one.
 * A SELLER:STEP5 whose data is not a PSBT of a transaction is refused as a schema error.
 */

const {
    assert, sleep, waitFor, startServer, stopServer, connectClient, rawSpotOrder, ordersOf,
    allHistory, activeSwapSessions, sessionOf, eventsOf, emitSwap, negotiate, sendStep, txidFor, txidOf,
} = require('./common');

const serverStates = (client) => eventsOf(client, 'swap')
    .map((e) => e.args[0])
    .filter((ev) => ev.eventName === 'SERVER:STATE')
    .map((ev) => ev.data);

const clients = [];

// Maker rests a SELL at price 1; taker places a crossing BUY. Returns once the swap session exists.
const openSwap = async (url, tag) => {
    const M = await connectClient(url, `${tag}-maker`);
    const T = await connectClient(url, `${tag}-taker`);
    clients.push(M, T);
    M.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1 }));
    await waitFor(() => ordersOf(M.id).length === 1, { message: `${tag}: maker order rested` });
    T.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 1, id_desired: 2 }));
    await waitFor(() => eventsOf(T, 'new-channel').length === 1, { message: `${tag}: swap channel opened` });
    return { M, T, sid: sessionOf(T) };
};

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- a) the reported txid is the signed transaction's txid: settles ------
        {
            const { M, T, sid } = await openSwap(url, 'a');
            await negotiate(sid, T, M);
            emitSwap(T, sid, 'BUYER:STEP6', txidFor(sid));
            await waitFor(() => serverStates(M).some((s) => s.state === 'settled'), { message: 'a: settled notice' });
            assert.strictEqual(serverStates(T).find((s) => s.state === 'settled').txid, txidFor(sid),
                'F1a FAIL: settled notice does not carry the signed transaction txid');
            assert.ok(allHistory().some((h) => h.txid === txidFor(sid)), 'F1a FAIL: the signed txid was not recorded');
            console.log('F1a PASS: BUYER:STEP6 with the txid of the signed transaction settles and is recorded');
        }

        // ---- b) a well-formed txid that is not the signed transaction is refused --
        {
            const { M, T, sid } = await openSwap(url, 'b');
            await negotiate(sid, T, M);
            emitSwap(T, sid, 'BUYER:STEP6', txidOf('never-broadcast-transaction'));
            await sleep(300);
            assert.ok(!serverStates(M).some((s) => s.state === 'settled'),
                'F1b FAIL: a txid that is not the signed transaction settled the swap');
            assert.ok(!allHistory().some((h) => h.txid === txidOf('never-broadcast-transaction')),
                'F1b FAIL: a txid that is not the signed transaction was recorded');
            assert.ok(T.errors.some((e) => /BUYER:STEP6 is not the txid of the signed transaction/.test(e)),
                `F1b FAIL: refusal not reported to the buyer (got ${JSON.stringify(T.errors)})`);
            assert.strictEqual(activeSwapSessions(), 1, 'F1b FAIL: a refused report ended the session');
            assert.strictEqual(ordersOf(M.id)[0].lock, true, 'F1b FAIL: the maker was unlocked by a refused report');
            // The buyer then reports the right one, and the swap settles.
            emitSwap(T, sid, 'BUYER:STEP6', txidFor(sid));
            await waitFor(() => serverStates(M).some((s) => s.state === 'settled'), { message: 'b: settled after the correct report' });
            console.log('F1b PASS: a txid that is not the signed transaction is refused; the session stays signed and settles on the right one');
        }

        // ---- c) SELLER:STEP5 data that is not a transaction's PSBT is refused -------
        {
            const { M, T, sid } = await openSwap(url, 'c');
            await negotiate(sid, T, M, 4);
            emitSwap(M, sid, 'SELLER:STEP5', 'ef'.repeat(64));
            await sleep(300);
            assert.ok(M.errors.some((e) => /SELLER:STEP5 data does not match its schema/.test(e)),
                `F1c FAIL: a non-PSBT SELLER:STEP5 got no refusal (got ${JSON.stringify(M.errors)})`);
            assert.ok(!eventsOf(T, 'swap').some((e) => e.args[0].eventName === 'SELLER:STEP5'),
                'F1c FAIL: a non-PSBT SELLER:STEP5 was relayed to the buyer');
            await sendStep(sid, T, M, 4);
            emitSwap(T, sid, 'BUYER:STEP6', txidFor(sid));
            await waitFor(() => serverStates(M).some((s) => s.state === 'settled'), { message: 'c: settled after the valid PSBT' });
            console.log('F1c PASS: SELLER:STEP5 must carry a PSBT of a transaction; a valid one is accepted afterwards');
        }
    } finally {
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(1000)]);
    }
    process.exit(0);
})().catch((e) => {
    console.error('F1 FAIL:', e && e.stack || e);
    process.exit(1);
});
