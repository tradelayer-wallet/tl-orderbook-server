// src/index.ts  (WEB – Fastify only)
import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { initSocketService } from './services/socket';

const HTTPS_PORT = 443;
const HTTP_PORT = envConfig.SERVER_PORT || 3001;

const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });
const serverHTTP  = Fastify({ logger: true });

// Initialize routes (as before)
handleRoutes(serverHTTPS as any);
handleRoutes(serverHTTP  as any);

// Initialize orderbook + markets (as before)
initOrderbookService();
initMarketsService();

// If you previously initialized Socket.IO here, keep it
// await initSocketService([serverHTTPS, serverHTTP]); // only if your web relied on it

Promise.all([
  serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' }),
  serverHTTP.listen({ port: HTTP_PORT,  host: '0.0.0.0' }),
])
  .then(async () => {
    console.log('All services initialized successfully.');
  })
  .catch((err) => {
    console.error('Error initializing services:', err.message);
    process.exit(1);
  });
