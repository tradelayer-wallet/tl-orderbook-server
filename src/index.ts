import Fastify, { FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const SERVER_PORT = envConfig.SERVER_PORT || 443;
const HTTP_PORT = envConfig.HTTP_PORT || 9191;
const OPTIONS: FastifyServerOptions = {};

const serverSSL = Fastify(OPTIONS); // Secure server (e.g., SSL)
const serverHTTP = Fastify(OPTIONS); // Non-secure server (HTTP)

// Initialize services
handleRoutes(server);
handleRoutes(serverHTTP);

initSocketService(server);
initSocketService(serverHTTP);

initOrderbookService();
initMarketsService();

// Listener for secure server
server
    .listen(SERVER_PORT, '0.0.0.0')
    .then((serverUrl) => {
        console.log(`Secure Server Started: https://localhost:${SERVER_PORT}`);
    })
    .catch((error) => {
        console.error('Error starting secure server:', error.message);
        process.exit(1);
    });

// Listener for non-secure server
serverHTTP
    .listen(HTTP_PORT, '0.0.0.0')
    .then((serverUrl) => {
        console.log(`Non-Secure Server Started: http://localhost:${HTTP_PORT}`);
    })
    .catch((error) => {
        console.error('Error starting non-secure server:', error.message);
        process.exit(1);
    });
