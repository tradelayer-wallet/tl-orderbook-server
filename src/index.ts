import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
// We import our new SocketManager
import { SocketManager } from './services/socket/socket.manager';

const HTTPS_PORT = envConfig.HTTPS_PORT || 443;
const HTTP_PORT = envConfig.HTTP_PORT || 9191;

// Load SSL certificates
const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// 1) Create HTTPS Fastify instance
const serverHTTPS = Fastify({
  logger: true,
  https: SECURE_OPTIONS,
});

// 2) Create HTTP Fastify instance
const serverHTTP = Fastify({
  logger: true,
});

// Initialize routes
handleRoutes(serverHTTPS);
handleRoutes(serverHTTP);

// Initialize orderbook + markets
initOrderbookService();
initMarketsService();

// Start HTTPS server
serverHTTPS
  .listen({ port: HTTPS_PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`Secure server running on https://0.0.0.0:${HTTPS_PORT}`);

  })
  .catch((err) => {
    console.error('Error starting HTTPS server:', err.message);
    process.exit(1);
  });

// Start HTTP server
serverHTTP
  .listen({ port: HTTP_PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`Non-secure server running on http://0.0.0.0:${HTTP_PORT}`);

  })
  .catch((err) => {
    console.error('Error starting HTTP server:', err.message);
    process.exit(1);
  });
