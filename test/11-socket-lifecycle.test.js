'use strict';

/*
 * N3 + N5 (round 2) — per-socket state and swap counterparties follow the socket lifecycle.
 *
 * N3 proven bug (f7f1b28): the swap relay limiter kept one bucket per socket id
 * that a disconnect never released (swapEventLimiter was not dropped on disconnect).
 * N5 proven bug (f7f1b28, probes P6c/P6d): the remainder of a taker whose socket
 * disconnected mid-swap was rested on the book as a ghost. Later crossing orders then
 * tried to swap with a socket that no longer existed (TypeError in newChannel).
 *
 * Expected (post-fix):
 *  a) after every client disconnects, no rate-limit bucket survives in any limiter
 *  b) no resting order is owned by a disconnected socket (ghost remainder refused)
 *  c) a crossing order does not match a ghost; it rests, with no swap and no error
 *  d) the participant choke point refuses missing, disconnected or identical sockets
 */

// Instrument the limiter class BEFORE the service modules load. Every limiter
// instance is recorded so the bucket maps can be inspected after disconnect.
const path = require('path');
const BUILD = path.join(__dirname, '.build');
const rateMod = require(path.join(BUILD, 'utils/pure/rate-limit.pure'));
const OrigLimiter = rateMod.TokenBucketLimiter;
const LIMITERS = [];
class TrackedLimiter extends OrigLimiter {
    constructor(...args) {
        super(...args);
        LIMITERS.push(this);
    }
}
rateMod.TokenBucketLimiter = TrackedLimiter;

const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    eventsOf, rawSpotOrder, emitSwap, sessionOf, ordersOf, allOrders, allHistory,
    activeSwapSessions,
} = require('./common');

const bucketCounts = () => LIMITERS.map((l) => `${l.ratePerSec}/${l.burst}:${l.buckets.size}`);

const { txidOf } = require('./common');

(async () => {
    const { server, url } = await startServer();
    try {
        // ---- a) every limiter drains a disconnected socket ------------------
        const P = await connectClient(url, 'lim-maker');
        const Q = await connectClient(url, 'lim-taker');
        P.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1, price: 1, id_for_sale: 40, id_desired: 41, keypair: { address: 'lim-p', pubkey: 'lim-p' } }));
        await waitFor(() => ordersOf(P.id).length === 1, { message: 'limiter maker rested' });
        Q.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 41, id_desired: 40, keypair: { address: 'lim-q', pubkey: 'lim-q' } }));
        await waitFor(() => eventsOf(Q, 'new-channel').length === 1, { message: 'limiter swap opened' });
        emitSwap(Q, sessionOf(Q), 'SELLER:STEP1', 'lim-probe');   // consumes a swap-relay token
        Q.socket.emit('update-orderbook', { type: 'SPOT', first_token: 40, second_token: 41 }); // query token
        await sleep(200);
        emitSwap(Q, sessionOf(Q), 'BUYER:STEP6', txidOf('lim-txid'));             // closes the session cleanly
        await waitFor(() => allHistory().some((h) => h.txid === txidOf('lim-txid')), { message: 'precondition swap settled' });
        const populated = LIMITERS.filter((l) => l.buckets.size > 0).length;
        assert.ok(populated > 0, 'test precondition: limiters should hold buckets while connected');

        P.socket.close();
        Q.socket.close();
        await waitFor(() => LIMITERS.every((l) => l.buckets.size === 0), {
            timeout: 2000,
            message: `all limiter buckets released after disconnect (${bucketCounts().join(', ')})`,
        }).catch((e) => {
            throw new Error(`N3 FAIL: ${e.message}`);
        });
        console.log('N3a PASS: every limiter bucket of a disconnected socket is released');

        // ---- b) + c) ghost remainder of a disconnected taker --------------
        // G1 and G2 are buyers resting orders; GT sells 1.25 and is matched by both.
        const G1 = await connectClient(url, 'G1');
        const G2 = await connectClient(url, 'G2');
        const GT = await connectClient(url, 'GT');
        G1.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 1, price: 1, id_for_sale: 9, id_desired: 10, keypair: { address: 'g-g1', pubkey: 'g-g1' } }));
        await waitFor(() => ordersOf(G1.id).length === 1, { message: 'G1 rested' });
        G2.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 0.1, price: 1, id_for_sale: 9, id_desired: 10, keypair: { address: 'g-g2', pubkey: 'g-g2' } }));
        await waitFor(() => ordersOf(G2.id).length === 1, { message: 'G2 rested' });
        GT.socket.emit('new-order', rawSpotOrder({ action: 'SELL', amount: 1.25, price: 1, id_for_sale: 10, id_desired: 9, keypair: { address: 'g-gt', pubkey: 'g-gt' } }));
        await waitFor(() => eventsOf(G1, 'new-channel').length === 1, { message: 'swap 1 opened' });
        emitSwap(G1, sessionOf(G1), 'BUYER:STEP6', txidOf('ghost-txid-1'));       // settles swap 1; GT's remainder re-enters
        await waitFor(() => eventsOf(G2, 'new-channel').length === 1, { timeout: 3000, message: 'swap 2 (remainder) opened' });

        GT.socket.close();                                               // taker vanishes during swap 2
        await sleep(200);
        emitSwap(G2, sessionOf(G2), 'BUYER:STEP6', txidOf('ghost-txid-2'));      // swap 2 settles after GT is gone
        await waitFor(() => allHistory().some((h) => h.txid === txidOf('ghost-txid-2')), { timeout: 3000, message: 'swap 2 settled' });
        await sleep(300);

        const ghosts = allOrders().filter((o) => o.socket_id === GT.id);
        assert.strictEqual(ghosts.length, 0,
            `N5 FAIL: a disconnected socket still owns ${ghosts.length} resting order(s): ${JSON.stringify(ghosts.map((o) => o.props.amount))}`);
        console.log('N5b PASS: the disconnected taker\'s remainder was not rested as a ghost order');

        // ---- c) a crossing order must not be matched against a ghost ------
        const NF = await connectClient(url, 'NF');
        NF.socket.emit('new-order', rawSpotOrder({ action: 'BUY', amount: 0.5, price: 1, id_for_sale: 9, id_desired: 10, keypair: { address: 'g-nf', pubkey: 'g-nf' } }));
        await waitFor(() => eventsOf(NF, 'order:saved').length === 1 || NF.errors.length > 0, { timeout: 3000, message: 'crossing order answered' });
        await sleep(300);
        assert.strictEqual(eventsOf(NF, 'new-channel').length, 0, 'N5 FAIL: crossing order was matched against a disconnected socket');
        assert.ok(!NF.errors.some((e) => /Cannot read|undefined|TypeError/i.test(e)),
            `N5 FAIL: internal error leaked to client: ${NF.errors.join('; ')}`);
        assert.strictEqual(activeSwapSessions(), 0, 'N5 FAIL: a swap session was left open');
        console.log('N5c PASS: crossing order rests cleanly; no swap opened against a dead socket');

        // ---- d) the participant choke point ---------------------------------
        const swapMod = require(path.join(BUILD, 'services/channel-swap/channel-swap.class'));
        assert.strictEqual(typeof swapMod.resolveSwapParticipants, 'function',
            'N5 FAIL: resolveSwapParticipants choke point missing');
        const io = (entries) => ({ sockets: { sockets: new Map(entries) } });
        const tradeInfo = { buyer: { socketId: 'b' }, seller: { socketId: 's' } };
        const live = { id: 'x', connected: true };
        const dead = { id: 'y', connected: false };
        assert.ok(swapMod.resolveSwapParticipants(io([['b', live]]), tradeInfo).error, 'N5 FAIL: missing seller accepted');
        assert.ok(swapMod.resolveSwapParticipants(io([['b', dead], ['s', live]]), tradeInfo).error, 'N5 FAIL: disconnected buyer accepted');
        assert.ok(swapMod.resolveSwapParticipants(io([['b', live], ['s', dead]]), tradeInfo).error, 'N5 FAIL: disconnected seller accepted');
        const same = { id: 'z', connected: true };
        assert.ok(swapMod.resolveSwapParticipants(io([['b', same], ['s', same]]), tradeInfo).error, 'N5 FAIL: one socket as both sides accepted');
        const ok = swapMod.resolveSwapParticipants(io([['b', live], ['s', { id: 'w', connected: true }]]), tradeInfo);
        assert.ok(ok.data && ok.data.buyer === live, 'N5 FAIL: two live distinct sockets rejected');
        console.log('N5d PASS: participant choke point refuses missing, disconnected and identical sockets');

        G1.socket.close();
        G2.socket.close();
        NF.socket.close();
        await stopServer(server);
        console.log('N3/N5 (socket lifecycle): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('N3/N5 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
