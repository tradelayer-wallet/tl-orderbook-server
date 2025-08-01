import HyperExpress from 'hyper-express';
import * as fs from 'fs';
import { handleRoutes } from './routes/routes';
import { socketManager } from './services/socket/'; // Import directly!
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

// Attach orderbook/market REST (OPTIONAL) -- can skip if you only want REST on one
[wsServer, wssServer].forEach((srv) => {
  handleRoutes(srv);
});

// Initialize shared core services ONCE
initOrderbookService();
initMarketsService();

// Attach the same SocketManager to both servers
[wsServer, wssServer].forEach((srv) => {
  // Attach both / and /ws for legacy/flex clients
  srv.ws('/',  ws => socketManager.handleOpen(ws));
  srv.ws('/ws', ws => socketManager.handleOpen(ws));
});

console.log('[Init] SocketManager attached to all listeners');

// ---- Start WS (no SSL) ----
wsServer.listen(WS_PORT, '0.0.0.0')
  .then(() => console.log(`[WS] listening on ws://0.0.0.0:${WS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WS] failed:', e?.message || e); process.exit(1); });

// ---- Start WSS (with SSL) ----
wssServer.listen(WSS_PORT, '0.0.0.0')
  .then(() => console.log(`[WSS] listening on wss://0.0.0.0:${WSS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WSS] failed:', e?.message || e); process.exit(1); });
