// src/index.ts
import * as fs from 'fs';
import Fastify from 'fastify';
import HyperExpress from 'hyper-express';
import fastifyExpress from 'fastify-express';

import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { initSocketService } from './services/socket';

// ---------- Ports ----------
const HTTPS_PORT = 443; // Web over TLS
const FASTIFY_HTTP_PORT = Number(process.env.HTTP_PORT ?? envConfig.SERVER_PORT ?? 3001); // Web HTTP (optional)
const WS_PORT = Number(process.env.WS_PORT ?? 3002); // Raw WS for NPM/desktop

// ---------- TLS for Fastify ----------
const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// ===== HyperExpress (raw WS only for NPM/desktop) =====
const wsServer = new HyperExpress.Server();
wsServer.get('/healthz', (req, res) => res.send('ok'));

// Core services (singletons)
initOrderbookService();
initMarketsService();

// Attach SocketManager on HyperExpress; it binds '/' and '/ws'
initSocketService([wsServer]);

// Start HyperExpress first
wsServer
  .listen(WS_PORT, '0.0.0.0')
  .then(() => console.log(`[WS] listening on ws://0.0.0.0:${WS_PORT}/ws (and /)`))
  .catch((e) => {
    console.error('[WS] failed:', e?.message || e);
    process.exit(1);
  });

// ===== Fastify (web: HTTPS + optional HTTP) =====
const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });
const serverHTTP  = Fastify({ logger: true });

(async () => {
  try {
    // Register middleware plugin BEFORE routes (handleRoutes uses app.use)
    await serverHTTPS.register(fastifyExpress);
    await serverHTTP.register(fastifyExpress);

    // Register your existing routes on both Fastify instances
    handleRoutes(serverHTTPS as any);
    handleRoutes(serverHTTP  as any);

    // Health (optional)
    serverHTTPS.get('/healthz', async () => 'ok');
    serverHTTP.get('/healthz', async () => 'ok');

    // Start Fastify listeners
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
