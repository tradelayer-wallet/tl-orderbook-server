// src/index.ts
import HyperExpress from 'hyper-express';
import fs from 'fs';

import { handleRoutes }     from './routes/routes';
import { envConfig }        from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService }   from './services/markets';

const HTTP_PORT  = envConfig.HTTP_PORT   || 9191;     // raw ws://IP:9191
const HTTPS_PORT = envConfig.HTTPS_PORT  || 443;      // wss://layerwallet.com

/* ────────────────────────────────────
   Create TWO HyperExpress servers
──────────────────────────────────── */

// 1) Plain-text WebSocket endpoint (raw IP for desktop)
const httpServer = new HyperExpress.Server();

// 2) TLS endpoint for wss.layerwallet.com
const httpsServer = new HyperExpress.Server({
  key_file_name : '/home/ubuntu/ssl/privkey.pem',
  cert_file_name: '/home/ubuntu/ssl/fullchain.pem'
});

/* ---- Register routes & services on BOTH ---- */
[httpServer, httpsServer].forEach(srv => {
  handleRoutes(srv);
});

/* ---- Shared singleton services ---- */
initOrderbookService();
initMarketsService();
initSocketService([httpServer, httpsServer]);

/* ---- Start listeners ---- */
httpServer.listen(HTTP_PORT,  '0.0.0.0')
  .then(() => console.log(`HTTP  WS  : ws://0.0.0.0:${HTTP_PORT}/ws`))
  .catch(e  => { console.error(e); process.exit(1); });

httpsServer.listen(HTTPS_PORT, '0.0.0.0')
  .then(() => console.log(`HTTPS WSS : wss://layerwallet.com:${HTTPS_PORT}/ws`))
  .catch(e  => { console.error(e); process.exit(1); });
