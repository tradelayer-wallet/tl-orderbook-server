'use strict';

/*
 * Round 8 — seeded property test of the matching engine against a reference model.
 *
 * The real server runs in-process. For each seed, a random sequence of limit orders is
 * placed by four sockets (three shared addresses, so same-address refusals occur too), with
 * a mix of whole, 2-, 6- and 8-decimal quantities, dust, and some 9-decimal values that
 * must be refused at intake. Every swap is completed by its buyer through the protocol.
 *
 * After every operation the server's state must equal the model's, exactly:
 *   - the resting book (socket, side, price, amount) as a multiset, in 1e-8 units;
 *   - the trade history, in order: buyer, seller, quantity and LTC value, in units;
 *   - the book is never crossed (no resting bid at or above a resting ask);
 *   - conservation: 2 x traded + resting + dropped == placed.
 * The model uses BigInt and exact arithmetic. It applies the server's rules: best price,
 * then arrival order; a best match from the same socket or address refuses the order; a
 * trade whose LTC value is not a whole number of satoshis is refused; a remainder re-enters
 * as a new order at the back of its price level.
 */
const fs = require('fs');
const path = require('path');
const {
    assert, sleep, waitFor, startServer, stopServer, connectClient,
    rawSpotOrder, allOrders, allHistory, activeSwapSessions, txidOf, workDir,
} = require('./common');

const UNIT = 100000000n;
const toU = (x) => BigInt(Math.round(x * 100000000));
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const OPS_PER_SEED = 40;

// Deterministic PRNG (mulberry32): the same seed always gives the same run.
const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const decimals = (r, places) => Number((r() * places[0]).toFixed(places[1])) || 1 / Math.pow(10, places[1]);
const AMOUNT_CLASSES = [
    (r) => 1 + Math.floor(r() * 5),                    // whole
    (r) => decimals(r, [3, 2]),                        // 2 decimals
    (r) => decimals(r, [2, 6]),                        // 6 decimals
    (r) => decimals(r, [0.0002, 8]),                   // dust, 8 decimals
    (r) => decimals(r, [1e-6, 8]),                     // sub-micro dust, 8 decimals
];
const PRICES = [0.5, 1, 1.5, 2, 1.0000009, 0.33333333];

// Reference model: exact, in units. See the header for the rules it applies.
class Model {
    constructor() {
        this.resting = [];
        this.seq = 0;
        this.trades = [];
        this.placed = 0n;
        this.dropped = 0n;
    }

    submit(order) {
        this.placed += order.amountU;
        const taker = { ...order };
        for (;;) {
            const opposite = this.resting.filter((m) => m.action !== taker.action && m.amountU > 0n
                && (taker.action === 'BUY' ? m.priceU <= taker.priceU : m.priceU >= taker.priceU));
            opposite.sort((a, b) => {
                const byPrice = taker.action === 'BUY'
                    ? (a.priceU < b.priceU ? -1 : a.priceU > b.priceU ? 1 : 0)
                    : (a.priceU > b.priceU ? -1 : a.priceU < b.priceU ? 1 : 0);
                return byPrice || a.seq - b.seq;
            });
            if (opposite.length === 0) {
                this.resting.push({ ...taker, seq: ++this.seq });
                return 'rested';
            }
            const m = opposite[0];
            if (m.socket === taker.socket || m.address === taker.address) {
                this.dropped += taker.amountU;
                return 'refused-self';
            }
            const q = taker.amountU < m.amountU ? taker.amountU : m.amountU;
            const value = q * m.priceU;
            if (value % UNIT !== 0n) {
                this.dropped += taker.amountU;
                return 'refused-value';
            }
            const buyer = taker.action === 'BUY' ? taker.socket : m.socket;
            const seller = taker.action === 'BUY' ? m.socket : taker.socket;
            this.trades.push({ buyer, seller, qU: q, valueSats: value / UNIT });
            m.amountU -= q;
            if (m.amountU === 0n) this.resting = this.resting.filter((x) => x !== m);
            taker.amountU -= q;
            if (taker.amountU === 0n) return 'filled';
        }
    }

    traded() {
        return this.trades.reduce((sum, t) => sum + t.qU, 0n);
    }

    bookKeys() {
        return this.resting.map((o) => `${o.socket}|${o.action}|${o.priceU}|${o.amountU}`).sort();
    }
}

const serverBookKeys = () => allOrders().map((o) => `${o.socket_id}|${o.action}|${toU(o.props.price)}|${toU(o.props.amount)}`).sort();

// Answers every swap that is waiting for its buyer, then waits until the book is quiet.
const settle = async (clients, answered) => {
    let quietRounds = 0;
    for (let i = 0; i < 600 && quietRounds < 4; i++) {
        for (const c of clients) {
            for (const ev of c.inbox.filter((e) => e.event === 'new-channel')) {
                const sid = ev.args[0].sessionId;
                if (!ev.args[0].isBuyer || answered.has(sid)) continue;
                answered.add(sid);
                c.socket.emit('swap', { sessionId: sid, eventName: 'BUYER:STEP6', data: txidOf(`s8-${sid}`) });
            }
        }
        await sleep(15);
        quietRounds = activeSwapSessions() === 0 ? quietRounds + 1 : 0;
    }
    assert.equal(activeSwapSessions(), 0, 'swaps did not settle');
};

const runSeed = async (seed) => {
    const r = rng(seed);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    // A new book loads its trade history from logs/, so each seed starts from an empty log.
    const logs = path.join(workDir, 'logs');
    fs.rmSync(logs, { recursive: true, force: true });
    fs.mkdirSync(logs);
    const { server, url } = await startServer();
    const clients = [];
    try {
        for (let i = 0; i < 4; i++) clients.push(await connectClient(url, `p8-${seed}-${i}`));
        const addresses = ['addr-A', 'addr-B', 'addr-C'];
        const model = new Model();
        const answered = new Set();
        const log = [];

        for (let op = 0; op < OPS_PER_SEED; op++) {
            const client = pick(clients);
            const action = r() < 0.5 ? 'BUY' : 'SELL';
            const price = pick(PRICES);
            const amountClass = pick(AMOUNT_CLASSES);
            // About 1 in 12 quantities has 9 decimals: it must be refused at intake, with no state change.
            const nineDecimal = r() < 0.08;
            // A 9th decimal digit is added on top of an 8-decimal value, so the number has 9 places.
            const amount = nineDecimal ? Number((1 + r()).toFixed(8)) + 1e-9 : amountClass(r);
            const address = pick(addresses);
            const idPair = action === 'BUY' ? { id_for_sale: 1, id_desired: 2 } : { id_for_sale: 2, id_desired: 1 };
            log.push(`${op}: ${client.name} ${action} ${amount} @ ${price} ${address}`);

            const inboxBefore = client.inbox.length;
            const errorsBefore = client.errors.length;
            if (nineDecimal) {
                client.socket.emit('new-order', rawSpotOrder({ action, amount, price, keypair: { address, pubkey: `pk-${address}` }, ...idPair }));
                await waitFor(() => client.errors.length > errorsBefore, { message: `refusal of 9-decimal amount, op ${op}` });
                assert.match(client.errors[client.errors.length - 1], /multiple of 1e-8/, log.join('\n'));
                continue;
            }

            model.submit({
                socket: client.id,
                address,
                action,
                priceU: toU(price),
                amountU: toU(amount),
            });
            client.socket.emit('new-order', rawSpotOrder({ action, amount, price, keypair: { address, pubkey: `pk-${address}` }, ...idPair }));
            // The server's first answer to this order: saved (rested), an error (refused), or a
            // swap (matched). Waiting for it means the order has been processed before the book is read.
            await waitFor(() => client.inbox.slice(inboxBefore).some((e) => ['order:saved', 'order:error', 'new-channel'].includes(e.event)),
                { timeout: 5000, message: `server answer to op ${op}` });
            await settle(clients, answered);

            // 1. The resting book equals the model's.
            assert.deepStrictEqual(serverBookKeys(), model.bookKeys(), `book differs after op ${op}\n${log.join('\n')}`);

            // 2. The trade history equals the model's, in order (the history is newest first).
            const serverTrades = allHistory().slice().reverse().map((h) =>
                `${h.buyer.socketId}|${h.seller.socketId}|${toU(h.props.amountDesired)}|${toU(h.props.amountForSale)}`);
            const modelTrades = model.trades.map((t) => `${t.buyer}|${t.seller}|${t.qU}|${t.valueSats}`);
            assert.deepStrictEqual(serverTrades, modelTrades, `trades differ after op ${op}\n${log.join('\n')}`);

            // 3. The book is never crossed: no resting bid at or above a resting ask.
            const bids = allOrders().filter((o) => o.action === 'BUY').map((o) => toU(o.props.price));
            const asks = allOrders().filter((o) => o.action === 'SELL').map((o) => toU(o.props.price));
            if (bids.length && asks.length) {
                const bestBid = bids.reduce((a, b) => (a > b ? a : b));
                const bestAsk = asks.reduce((a, b) => (a < b ? a : b));
                assert.ok(bestBid < bestAsk, `crossed book after op ${op}: bid ${bestBid} >= ask ${bestAsk}`);
            }

            // 4. Conservation in units: 2 x traded + resting + dropped == placed.
            const resting = model.resting.reduce((sum, o) => sum + o.amountU, 0n);
            assert.equal(2n * model.traded() + resting + model.dropped, model.placed, `quantity not conserved after op ${op}`);
        }
        return { trades: model.trades.length };
    } finally {
        // Close the clients first: fastify's close waits for open WebSocket connections.
        clients.forEach((c) => c.socket.close());
        await Promise.race([stopServer(server), sleep(2000)]);
    }
};

(async () => {
    try {
        let trades = 0;
        for (const seed of SEEDS) {
            const res = await runSeed(seed);
            trades += res.trades;
        }
        assert.ok(trades > 0, 'the property run never traded: the generator is not exercising matching');
        console.log(`R8 PASS: matching model agrees on ${SEEDS.length} seeds x ${OPS_PER_SEED} ops (${trades} trades)`);
        process.exit(0);
    } catch (e) {
        console.error('R8 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
