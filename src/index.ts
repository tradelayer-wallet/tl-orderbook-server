import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
//import { SocketManager } from './services/socket/manager.class';
import { initSocketService } from './services/socket';


const HTTPS_PORT = 443;
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
  .then(async () => {
    await initSocketService([serverHTTPS, serverHTTP]);
    console.log('All services initialized successfully.');
  })
  .catch((err) => {
    console.error('Error initializing services:', err.message);
    process.exit(1);
  });
