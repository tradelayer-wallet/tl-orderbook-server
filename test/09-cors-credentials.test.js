'use strict';

/*
 * N4 (round 2) — CORS credentials must never be emitted, least of all for the
 * opaque `null` origin.
 *
 * Proven bug (f7f1b28): the socket.io CORS options set `credentials: true`, and
 * the `cors` package sends Access-Control-Allow-Credentials for every origin.
 * The engine.io handshake therefore answered `Origin: null` with
 * ACAO: null + ACAC: true.
 *
 * Expected (post-fix), on the HTTP routes AND the socket.io handshake:
 *  a) no Access-Control-Allow-Credentials header for any origin
 *  b) `null` (the Electron file:// UI) is still allowed by the default
 *     allowlist, so ACAO: null is still reflected (compatibility kept)
 *  c) an origin outside the allowlist gets no ACAO and no ACAC
 */
const {
    assert, startServer, stopServer, httpGet,
} = require('./common');

const acao = (res) => res.headers['access-control-allow-origin'];
const acac = (res) => res.headers['access-control-allow-credentials'];

(async () => {
    const { server, url } = await startServer();
    try {
        const markets = `${url}/markets/spot`;
        const handshake = `${url}/socket.io/?EIO=4&transport=polling`;

        for (const target of [markets, handshake]) {
            for (const origin of ['null', 'https://layerwallet.com', 'https://evil.example']) {
                const res = await httpGet(target, { Origin: origin });
                assert.strictEqual(acac(res), undefined,
                    `N4 FAIL: ${target} with Origin ${origin} sent Access-Control-Allow-Credentials=${acac(res)}`);
            }
        }
        console.log('N4a PASS: no Access-Control-Allow-Credentials on HTTP routes or socket.io handshake, any origin');

        const nullHttp = await httpGet(markets, { Origin: 'null' });
        const nullHs = await httpGet(handshake, { Origin: 'null' });
        assert.strictEqual(acao(nullHttp), 'null', 'N4 FAIL: null origin no longer admitted on HTTP routes');
        assert.strictEqual(acao(nullHs), 'null', 'N4 FAIL: null origin no longer admitted on socket.io handshake');
        console.log('N4b PASS: null origin still admitted (ACAO: null) on both surfaces');

        const evilHttp = await httpGet(markets, { Origin: 'https://evil.example' });
        const evilHs = await httpGet(handshake, { Origin: 'https://evil.example' });
        assert.strictEqual(acao(evilHttp), undefined, 'N4 FAIL: foreign origin admitted on HTTP routes');
        assert.strictEqual(acao(evilHs), undefined, 'N4 FAIL: foreign origin admitted on socket.io handshake');
        console.log('N4c PASS: foreign origin gets no CORS headers');

        await stopServer(server);
        console.log('N4 (CORS credentials): ALL PASS');
        process.exit(0);
    } catch (e) {
        console.error('N4 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
