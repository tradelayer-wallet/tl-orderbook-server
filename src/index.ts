import * as fs from 'fs';
import Fastify from 'fastify';
import { envConfig } from './config/env.config';
import { handleRoutes } from './routes/routes';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const HTTPS_PORT = envConfig.HTTP_PORT || 443;

const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// Create a single Fastify instance with HTTPS
const server = Fastify({
  logger: true,
  https: SECURE_OPTIONS,
});

// Attach routes, Socket.IO, etc.
handleRoutes(server);
initSocketService(server);

initOrderbookService();
initMarketsService();

server
  .listen(HTTPS_PORT, '0.0.0.0')
  .then(() => {
    console.log(`Secure server running on https://0.0.0.0:${HTTPS_PORT}`);
  })
  .catch((err) => {
    console.error('Error starting HTTPS server:', err.message);
    process.exit(1);
  });
