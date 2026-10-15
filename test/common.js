'use strict';

/*
 * Shared bootstrap for the tl-orderbook-server regression tests.
 *
 * Boots the REAL production modules (socket manager, orderbook manager, swap
 * engine, routes) on a random loopback port from a scratch working directory
 * under os.tmpdir(), so the server's `logs/` side effects never touch the repo.
 * The only shim: a fake readFileSync for the hardcoded letsencrypt cert paths
 * (not present on a dev machine). fastify-socket.io attaches socket.io to
 * fastify's plain http server, so the key/cert material is never actually used
 * — it just must not throw.
 *
 * Clients: a small socket.io v4 client over Node's built-in WebSocket (see
 * openSocket below), so the tests need no client dependency.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Compiled output of the repo sources (test/tsconfig.json, outside the main build).
const BUILD = path.join(__dirname, '.build');

// --- fake TLS material shim (installed before any module reads those paths) ---
const realReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = function (p) {
    const s = String(p);
    if (s.indexOf('/etc/letsencrypt/') !== -1) {
        const label = s.endsWith('privkey.pem') ? 'PRIVATE KEY' : 'CERTIFICATE';
        return `-----BEGIN ${label}-----\nfake-harness-material\n-----END ${label}-----\n`;
    }
    return realReadFileSync.apply(fs, arguments);
};

// --- scratch cwd (the orderbook reads/writes ./logs relative to cwd) ---
// Each process gets its own mkdtemp directory under os.tmpdir(), removed on exit.
const testName = path.basename(process.argv[1] || 'test').replace(/\.test\.js$/, '');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-ob-${testName}-`));
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });
process.on('exit', () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});
process.chdir(workDir);

// Short swap timeout unless the test asks for something else. Must be set
// before the config module is loaded.
if (!process.env.SWAP_TIMEOUT_MS) process.env.SWAP_TIMEOUT_MS = '4000';

const Fastify = require('fastify');

const socketMod = require(path.join(BUILD, 'services/socket'));
const orderbookMod = require(path.join(BUILD, 'services/orderbook'));
const { handleRoutes } = require(path.join(BUILD, 'routes/routes'));
const { envConfig } = require(path.join(BUILD, 'config/env.config'));
const mixPure = require(path.join(BUILD, 'utils/pure/mix.pure'));
const swapMod = require(path.join(BUILD, 'services/channel-swap/channel-swap.class'));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const waitFor = async (fn, opts = {}) => {
    const { timeout = 5000, interval = 25, message = 'condition' } = opts;
    const start = Date.now();
    for (;;) {
        let v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return v;
        if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms: ${message}`);
        await sleep(interval);
    }
};

async function startServer({ routes = true } = {}) {
    const server = Fastify({ logger: false });
    if (routes) handleRoutes(server);
    socketMod.initSocketService(server);
    orderbookMod.initOrderbookService();
    await server.listen(0, '127.0.0.1');
    const port = server.server.address().port;
    await sleep(150); // let SocketManager's ready() hook register connection handlers
    return { server, port, url: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
    try { await server.close(); } catch (e) { /* ignore */ }
}

// --- socket.io v4 client over the engine.io WebSocket transport ---------------
//
// Implements exactly what the scenarios use: emit, on, onAny, id, close, and the
// 'connect' / 'connect_error' / 'disconnect' lifecycle events. Wire format:
//   engine.io: '2' ping -> '3' pong; '0' open; '4' message wrapper
//   socket.io: '40' connect (default namespace), '42[...]' event,
//              '44{...}' connect error, '41' disconnect.
// `headers` is sent on the WebSocket handshake (used to test the Origin gate).
// Node's global WebSocket (Node >= 22) accepts a `headers` init option.
function openSocket(url, { headers = {}, timeout = 5000 } = {}) {
    const wsUrl = `${url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
    const handlers = new Map();
    const anyHandlers = [];
    let connected = false;
    let settled = false;

    const socket = {
        id: null,
        connected: false,
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
            return socket;
        },
        onAny(fn) { anyHandlers.push(fn); return socket; },
        emit(event, ...args) {
            if (!connected) throw new Error(`emit('${event}') on a socket that is not connected`);
            ws.send(`42${JSON.stringify([event, ...args])}`);
        },
        close() {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        },
    };

    // Server events go to onAny listeners too; lifecycle events do not (as in socket.io-client).
    const local = (event, args) => (handlers.get(event) || []).forEach((fn) => fn(...args));
    const dispatch = (event, args) => {
        anyHandlers.forEach((fn) => fn(event, ...args));
        local(event, args);
    };
    const fail = (err) => {
        if (settled) return;
        settled = true;
        local('connect_error', [err]);
    };

    const timer = setTimeout(() => {
        if (!connected) { fail(new Error('connect timeout')); socket.close(); }
    }, timeout);

    const ws = new WebSocket(wsUrl, { headers });
    ws.onmessage = (msg) => {
        const data = String(msg.data);
        if (data === '2') { ws.send('3'); return; }                // engine.io ping
        if (data.startsWith('0')) { ws.send('40'); return; }        // engine.io open -> socket.io connect
        if (data.startsWith('40')) {                                // socket.io connected
            connected = true;
            socket.connected = true;
            socket.id = JSON.parse(data.slice(2)).sid;
            clearTimeout(timer);
            settled = true;
            local('connect', []);
            return;
        }
        if (data.startsWith('44')) {                                // socket.io connect error
            const body = JSON.parse(data.slice(2));
            clearTimeout(timer);
            fail(new Error(body.message || 'connection refused'));
            return;
        }
        const ev = /^42(\[.*)$/s.exec(data);                        // event (no ack ids used)
        if (ev) {
            const [event, ...args] = JSON.parse(ev[1]);
            dispatch(event, args);
        }
    };
    ws.onerror = () => { clearTimeout(timer); fail(new Error('websocket error')); };
    ws.onclose = () => {
        clearTimeout(timer);
        const wasConnected = connected;
        connected = false;
        socket.connected = false;
        if (wasConnected) local('disconnect', ['transport close']);
        else fail(new Error('websocket closed before connect'));
    };
    return socket;
}

async function connectClient(url, name) {
    const socket = openSocket(url);
    const state = {
        name,
        socket,
        id: null,
        inbox: [],   // { event, args, at }
        errors: [],  // order:error payloads
    };
    socket.onAny((event, ...args) => state.inbox.push({ event, args, at: Date.now() }));
    socket.on('order:error', (m) => state.errors.push(String(m)));
    await new Promise((res, rej) => {
        socket.on('connect', () => res());
        socket.on('connect_error', (e) => rej(new Error(`${name}: connect_error ${e && e.message}`)));
    });
    state.id = socket.id;
    return state;
}

function eventsOf(client, event) {
    return client.inbox.filter((e) => e.event === event);
}

async function waitForEvent(client, event, pred = () => true, opts = {}) {
    return waitFor(() => eventsOf(client, event).find((e) => pred(...e.args)), {
        message: `${client.name} to receive '${event}'`,
        ...opts,
    });
}

// --- order / swap payload helpers -------------------------------------------

let orderSeq = 0;
// Accepts shorthand top-level amount/price/id_for_sale/id_desired and/or a full
// `props` override; everything else is spread at the top level of the payload.
const rawSpotOrder = (over = {}) => {
    const {
        props: propsOver = {},
        amount, price, id_for_sale, id_desired,
        ...rest
    } = over;
    const shorthand = {};
    if (amount !== undefined) shorthand.amount = amount;
    if (price !== undefined) shorthand.price = price;
    if (id_for_sale !== undefined) shorthand.id_for_sale = id_for_sale;
    if (id_desired !== undefined) shorthand.id_desired = id_desired;
    return {
        type: 'SPOT',
        action: 'BUY',
        isLimitOrder: true,
        marketName: 'TEST/TEST',
        keypair: { address: `addr-${++orderSeq}`, pubkey: `pk-${orderSeq}` },
        ...rest,
        props: { id_for_sale: 2, id_desired: 1, amount: 1, price: 1, ...shorthand, ...propsOver },
    };
};

const swapEvent = (eventName, socketId, data) => ({ eventName, socketId, data });

// Swap protocol: every swap event is sent on the single 'swap' event and must
// carry the sessionId the server issued in 'new-channel'.
const emitSwap = (client, sessionId, eventName, data, claimedSocketId = client.id) => {
    client.socket.emit('swap', { sessionId, ...swapEvent(eventName, claimedSocketId, data) });
};

// Deterministic 64-hex transaction id for a readable fixture label (BUYER:STEP6 accepts only that shape).
const txidOf = (label) => require('crypto').createHash('sha256').update(label).digest('hex');

// sessionId of the n-th swap session a client was given (default: the latest one).
const sessionOf = (client, index = -1) => {
    const ev = eventsOf(client, 'new-channel');
    const picked = index < 0 ? ev[ev.length + index] : ev[index];
    if (!picked) throw new Error(`${client.name} has no new-channel event at index ${index}`);
    return picked.args[0].sessionId;
};

// --- server-side introspection ----------------------------------------------

const getOrderbookManager = () => {
    const m = orderbookMod.orderbookManager;
    if (!m) throw new Error('orderbookManager not initialised');
    return m;
};

const allOrders = () => getOrderbookManager().orderbooks.reduce((a, b) => a.concat(b.orders), []);
const ordersOf = (socketId) => getOrderbookManager().getOrdersBySocketId(socketId);
// Every trade the server has logged, newest first (the order a live book keeps). The logs are the
// record: a book that holds no orders is released, and its trades are read back from its logs.
const allHistory = () => {
    const dir = path.join(process.cwd(), 'logs');
    const records = [];
    fs.readdirSync(dir)
        .filter((f) => f.startsWith('TRADE-'))
        .forEach((f) => {
            fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, -1)
                .forEach((line) => records.push(JSON.parse(line)));
        });
    return records.reverse();
};

// Number of swap sessions the server still holds (not yet settled or timed out).
const activeSwapSessions = () => swapMod.activeSwapSessionCount();

// Simple raw HTTP GET (for CORS header assertions).
const httpGet = (url, headers = {}) => new Promise((res, rej) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on('error', rej);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
});

module.exports = {
    assert,
    txidOf,
    BUILD,
    workDir,
    sleep,
    waitFor,
    startServer,
    stopServer,
    openSocket,
    connectClient,
    eventsOf,
    waitForEvent,
    rawSpotOrder,
    swapEvent,
    emitSwap,
    allOrders,
    ordersOf,
    allHistory,
    activeSwapSessions,
    sessionOf,
    httpGet,
    envConfig,
    mixPure,
};
