import HyperExpress from 'hyper-express';
import * as fs from 'fs';
import { handleRoutes } from './routes/routes';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

// Ports
const WS_PORT   = 3001;  // ws:// for desktop/NPM
const WSS_PORT  = 443;   // wss:// for web

// SSL options for HTTPS/WSS
const wssServer = new HyperExpress.Server({
  key_file_name: '/home/ubuntu/ssl/privkey.pem',
  cert_file_name: '/home/ubuntu/ssl/fullchain.pem',
});


// 1. Create HyperExpress server for WS (desktop/NPM)
const wsServer = new HyperExpress.Server();
// 2. Create HyperExpress server for WSS (web)

// Attach orderbook, market, socket services to BOTH servers
[wsServer, wssServer].forEach((srv) => {
  handleRoutes(srv); // If you want REST API also on both, otherwise skip
  initSocketService(srv); // Only register socket service ONCE per server!
});

// Init shared services
initOrderbookService();
initMarketsService();

// Listen on WS (no SSL)
wsServer.listen(WS_PORT, '0.0.0.0')
  .then(() => console.log(`[WS] listening on ws://0.0.0.0:${WS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WS] failed:', e?.message || e); process.exit(1); });

// Listen on WSS (with SSL)
wssServer.listen(WSS_PORT, '0.0.0.0')
  .then(() => console.log(`[WSS] listening on wss://0.0.0.0:${WSS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WSS] failed:', e?.message || e); process.exit(1); });
