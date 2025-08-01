// src/index.ts
import * as fs from 'fs';
import Fastify from 'fastify';
import HyperExpress from 'hyper-express';

import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { initSocketService } from './services/socket';

// ----- Ports (keep your old defaults) -----
const HTTPS_PORT = 443;                               // Web (HTTPS/SIO)
const FASTIFY_HTTP_PORT = envConfig.HTTP_PORT || 9191; // Optional extra HTTP Fastify (if you use it)
const WS_PORT = parseInt(process.env.HTTP_PORT || '3001', 10); // Raw WS for NPM/desktop

// ----- TLS for Fastify (web) -----
const SECURE_OPTIONS = {
  key:  fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// ===== Fastify (WEB: HTTPS + optional HTTP) =====
const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });
const serverHTTP  = Fastify({ logger: true }); // keep if you still want :9191

// Your existing web routes (REST + any Socket.IO relay you already had wired)
handleRoutes(serverHTTPS);
handleRoutes(serverHTTP);

// ===== HyperExpress (NPM/desktop RAW WS) =====
const hex = new HyperExpress.Server();

// (optional) health for WS process
hex.get('/healthz', (req, res) => res.send('ok'));

// Your SocketManager attaches BOTH '/' and '/ws' to every server you pass.
// We only pass the HyperExpress server here so it owns the raw WS endpoints.
initOrderbookService();
initMarketsService();
initSocketService([hex]);

// ===== Start everything =====
(async () => {
  try {
    // 1) HyperExpress raw WS (NPM/desktop): ws://<host>:3001/ws
    await hex.listen(WS_PORT, '0.0.0.0');
    console.log(`[HyperExpress] WS listening: ws://0.0.0.0:${WS_PORT}/ws and /`);

    // 2) Fastify HTTPS for web (Socket.IO/REST)
    await serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' });
    serverHTTPS.log.info(`HTTPS listening on :${HTTPS_PORT}`);

    // 3) Optional Fastify HTTP (if you still use :9191)
    await serverHTTP.listen({ port: FASTIFY_HTTP_PORT, host: '0.0.0.0' });
    serverHTTP.log.info(`HTTP listening on :${FASTIFY_HTTP_PORT}`);

    console.log('All services initialized successfully.');
  } catch (err: any) {
    console.error('Error initializing services:', err?.message || err);
    process.exit(1);
  }
})();
