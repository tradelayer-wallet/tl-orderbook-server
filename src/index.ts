// src/index.ts
import * as fs from 'fs';
import Fastify from 'fastify';
import HyperExpress from 'hyper-express';

import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { initSocketService } from './services/socket';

// ---------- Ports ----------
const HTTPS_PORT = 443; // web over TLS
const FASTIFY_HTTP_PORT = Number(process.env.HTTP_PORT ?? envConfig.SERVER_PORT ?? 3001); // web HTTP (if you use it)
const WS_PORT = Number(process.env.WS_PORT ?? 3002); // raw WS for NPM/desktop

// ---------- TLS for Fastify ----------
const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// ===== Fastify (web: HTTPS + optional HTTP) =====
const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });
const serverHTTP  = Fastify({ logger: true });

// If your Fastify routes were working before with handleRoutes(), keep calling it,
// but cast to any to satisfy TS because handleRoutes is typed for HyperExpress.
handleRoutes(serverHTTPS as any);
handleRoutes(serverHTTP  as any);

// Minimal health routes (optional)
serverHTTPS.get('/healthz', async () => 'ok');
serverHTTP.get('/healthz', async () => 'ok');

// ===== HyperExpress (raw WS only for NPM/desktop) =====
const hex = new HyperExpress.Server();
hex.get('/healthz', (req, res) => res.send('ok'));

// Your SocketManager constructor attaches BOTH '/' and '/ws' to each server passed in.
// We only pass the HyperExpress server so it owns the raw WS endpoints.
initOrderbookService();
initMarketsService();
initSocketService([hex]);

// ===== Start everything =====
(async () => {
  try {
    await hex.listen(WS_PORT, '0.0.0.0');
    console.log(`[HyperExpress] WS: ws://0.0.0.0:${WS_PORT}/ws and /`);

    await serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' });
    serverHTTPS.log.info(`HTTPS :${HTTPS_PORT}`);

    await serverHTTP.listen({ port: FASTIFY_HTTP_PORT, host: '0.0.0.0' });
    serverHTTP.log.info(`HTTP  :${FASTIFY_HTTP_PORT}`);

    console.log('All services initialized successfully.');
  } catch (err: any) {
    console.error('Error initializing services:', err?.message || err);
    process.exit(1);
  }
})();
