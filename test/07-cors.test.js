'use strict';

/*
 * Fix #3 — CORS default must admit the shipped wallet FE.
 *
 * The Electron UI is loaded from file:// pages, which send the opaque origin
 * `Origin: null` on every request to http://<host>:9190/markets/* (and on the
 * socket.io polling handshake). The old `Access-Control-Allow-Origin: *` served
 * it; the first hardening pass defaulted to deny-all and silently broke market
 * loading in the wallet. The chosen default therefore allows exactly:
 *   `null`, https://layerwallet.com, https://www.layerwallet.com
 * (same policy as the wallet's own socket.io server), driven by CORS_ORIGINS
 * for both the HTTP routes and socket.io. CORS_ORIGINS=off denies everything.
 *
 * Modes (CORS_TEST_MODE):
 *   (default)     assert the wallet FE defaults
 *   off           CORS_ORIGINS=off -> deny all
 *   custom        CORS_ORIGINS=https://foo.example -> only that origin
 */
const { execFileSync } = require('child_process');
const {
    assert, sleep, startServer, stopServer, httpGet,
} = require('./common');

const MODE = process.env.CORS_TEST_MODE || 'default';

const acao = (res) => res.headers['access-control-allow-origin'];

const check = async (url, origin, expected) => {
    const res = await httpGet(url, { Origin: origin });
    assert.strictEqual(acao(res), expected,
        `Origin ${origin} on ${url}: expected ACAO ${expected}, got ${acao(res)} (status ${res.status})`);
};

(async () => {
    const { server, url } = await startServer();
    try {
        const markets = `${url}/markets/spot`;
        const handshake = `${url}/socket.io/?EIO=4&transport=polling`;

        if (MODE === 'default') {
            await check(markets, 'null', 'null');
            await check(markets, 'https://layerwallet.com', 'https://layerwallet.com');
            await check(markets, 'https://www.layerwallet.com', 'https://www.layerwallet.com');
            await check(markets, 'https://evil.example', undefined);
            await check(handshake, 'null', 'null');
            await check(handshake, 'https://evil.example', undefined);
            console.log('CORS PASS: file:// (Origin: null) + layerwallet.com admitted on /markets/* and socket.io; evil origins denied');

            for (const mode of ['off', 'custom']) {
                execFileSync(process.execPath, [__filename], {
                    stdio: 'inherit',
                    env: {
                        ...process.env,
                        CORS_TEST_MODE: mode,
                        CORS_ORIGINS: mode === 'off' ? 'off' : 'https://foo.example',
                    },
                });
            }
            console.log('CORS: ALL PASS');
        } else if (MODE === 'off') {
            await check(markets, 'null', undefined);
            await check(markets, 'https://layerwallet.com', undefined);
            await check(handshake, 'null', undefined);
            console.log('CORS PASS (off): CORS_ORIGINS=off denies all cross-origin access');
        } else if (MODE === 'custom') {
            await check(markets, 'https://foo.example', 'https://foo.example');
            await check(markets, 'null', undefined);
            await check(handshake, 'https://foo.example', 'https://foo.example');
            await check(handshake, 'null', undefined);
            console.log('CORS PASS (custom): CORS_ORIGINS override works for routes and socket.io');
        } else {
            throw new Error(`unknown mode ${MODE}`);
        }

        await stopServer(server);
        process.exit(0);
    } catch (e) {
        console.error(`CORS FAIL (mode=${MODE}):`, e && e.stack || e);
        process.exit(1);
    }
})();
