import * as fs from 'fs';
import Fastify from 'fastify';
import { envConfig } from './config/env.config';
import { handleRoutes } from './routes/routes';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { createSocketService } from './services/socket-dual';

const HTTPS_PORT = envConfig.HTTPS_PORT || 443;
const HTTP_PORT = envConfig.HTTP_PORT || 9191;

// SSL credentials for HTTPS
const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// 1) Create HTTPS Fastify server
const serverHTTPS = Fastify({
  logger: true,
  https: SECURE_OPTIONS,
});

// 2) Create HTTP Fastify server
const serverHTTP = Fastify({ logger: true });

// 3) Create a single Socket.IO “service”
const { attachToHTTPS, attachToHTTP } = createSocketService();

// Routes, DB init, etc.
handleRoutes(serverHTTPS);
handleRoutes(serverHTTP);

initOrderbookService();
initMarketsService();

// Start HTTPS
serverHTTPS
  .listen({ port: HTTPS_PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`HTTPS server running on https://0.0.0.0:${HTTPS_PORT}`);
    // Attach Socket.IO to the HTTPS server
    attachToHTTPS(serverHTTPS);
  })
  .catch((err) => {
    console.error('Error starting HTTPS server:', err.message);
    process.exit(1);
  });

// Start HTTP
serverHTTP
  .listen({ port: HTTP_PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`HTTP server running on http://0.0.0.0:${HTTP_PORT}`);
    // Attach Socket.IO to the HTTP server
    attachToHTTP(serverHTTP);
  })
  .catch((err) => {
    console.error('Error starting HTTP server:', err.message);
    process.exit(1);
  });
