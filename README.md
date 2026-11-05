# TradeLayer orderbook server

HyperExpress (uWebSockets) server with a Rust matching engine addon (`rust/matcher-core`).

    npm run build      # tsc -> dist/
    npm start          # node dist/index.js
    npm test           # test/channel-swap.test.js, then test/auth.test.js (Linux x86_64)

Runtime: Node 22. The locked uWebSockets.js 20.49.0 ships binaries for Node 18-22 only and refuses to
load on Node 24; CI (`.github/workflows/orderbook-auth.yml`) pins 22.23.3.

Listeners (environment): `TL_OB_BIND` (default `0.0.0.0`), `TL_OB_WS_PORT` (default `3001`, plain ws/http),
`TL_OB_WSS_PORT` (default `443`, TLS; `0` disables), `TL_OB_SSL_KEY` / `TL_OB_SSL_CERT`.
REST (`/markets`, `/logs`, `/auth`) is served on every listener.

## Login

A wallet proves control of a Bitcoin or Litecoin address by signing a server-issued challenge (BIP-322, or
BIP-137 for P2PKH). Supported addresses: P2WPKH, P2SH-P2WPKH, P2TR (key path), P2PKH; networks
`bc/tb/bcrt` and `ltc/tltc/rltc`. Verification runs in the native addon (`verifyBip322`).

1. `GET /auth/challenge` returns `{nonce, message, expiresAt}`. Valid for 2 minutes, single use.
2. Sign `message` with the address key.
3. `POST /auth/verify` with JSON `{address, message, signature}` returns `{sessionToken, token, expiresAt, address}` (both token fields hold the same value)
   (session lifetime 10 minutes) or 401.
4. On the WebSocket send `{event: "auth", token}`; the server answers `{event: "auth_ok", address, expiresAt}`.
   One socket may authenticate several addresses. A fresh token for an address before expiry extends it.

`POST /auth/logout {token}` revokes a session; `GET /auth/status` with `Authorization: Bearer <token>` reports it.

## Enforcement

* Every socket is a web client and must authenticate before `new-order`, `many-orders`, `amend-order`,
  `close-order`.
* `new-order` and `many-orders` need `keypair.address` to be an address authenticated on that socket. A batch is
  accepted or rejected as a whole.
* `amend-order` and `close-order` need the stored order's owner address to be authenticated on that socket.
  An order uuid already held by another address cannot be reused.
* Expired or revoked sessions drop their address; it is checked on every mutation.
* No header selects a client class. A bot connects with an API key (`x-tl-api-key` header or `apiKey` query
  parameter) whose sha256 is listed in `TL_OB_BOT_KEYS` (comma separated hex digests). Bots skip session auth and
  address binding. A wrong key is refused.

Limits (environment): `TL_OB_CHALLENGES_PER_MIN` (30 per IP), `TL_OB_VERIFIES_PER_MIN` (60 per IP),
`TL_OB_MAX_CHALLENGES` (20000 pending), `TL_OB_MAX_SESSIONS` (100000), `TL_OB_CHALLENGE_TTL_MS`,
`TL_OB_SESSION_TTL_MS`, `TL_OB_AUTH_NETWORK` (`auto`, or one of `btc tbtc rbtc ltc tltc rltc`).

## Native addon

`rust/matcher-core/matcher_core.node` is built on Linux x86_64 with `rust/OrderBook-rs.zip` unzipped beside it:

    cd rust/matcher-core && cargo +1.90.0 build --release --locked
    cp target/release/libmatcher_core.so matcher_core.node

`rust/bip322-core` holds the verifier and its tests (`cargo test --locked`), including the official BIP-322 vectors.
