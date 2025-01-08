import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
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

// Start both servers and initialize SocketManager
Promise.all([
  serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' }),
  serverHTTP.listen({ port: HTTP_PORT, host: '0.0.0.0' }),
])
  .then(async ([httpsAddress, httpAddress]) => {
    const httpsPort = typeof httpsAddress === 'string' ? httpsAddress : httpsAddress?.port;
    const httpPort = typeof httpAddress === 'string' ? httpAddress : httpAddress?.port;

    console.log(`Secure server running at port: ${httpsPort}`);
    console.log(`Non-secure server running at port: ${httpPort}`);

    await SocketManager.init([serverHTTPS, serverHTTP]);
  })
  .catch((err) => {
    console.error('Error starting servers:', err.message);
    process.exit(1);
  });

