# tl-orderbook-server

TradeLayer orderbook server. It matches spot and futures orders over socket.io and runs the swap session between the two wallets of a matched trade.

## Commands

- `npm test`: compiles the sources into `test/.build` and runs the scenarios in `test/`.
- `npm run build`, `npm start`: build and run `dist/index.js`.

## Per-IP connection cap

`MAX_CONNECTIONS_PER_IP` (default 20) limits the live sockets per address. The check in `SocketManager.admitConnection` keys on `socket.client.conn.remoteAddress`, the address of the TCP peer. The server does not read `X-Forwarded-For` or any other forwarded header, and it has no trust-proxy setting.

Behind a reverse proxy every client arrives from the proxy's address. The whole service then shares one budget of 20 live sockets, and users behind one NAT or CGNAT egress share it as well. Before running behind a proxy, change the admission key: take the client address from the forwarded header only from the proxy hop that is trusted, and ignore that header from any other peer. Until then the cap is a per-egress-address limit.
