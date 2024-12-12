import Fastify, { FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import * as fs from 'fs'

const SERVER_PORT = envConfig.SERVER_PORT || 443;
const HTTP_PORT = envConfig.HTTP_PORT || 9191;
const SECURE_OPTIONS: FastifyServerOptions = {
    https: {
        key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
        cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
    },
};
// Create servers
const server = Fastify(SECURE_OPTIONS); // Secure server (HTTPS)
const serverHTTP = Fastify(); // Non-secure server (HTTP)

// Initialize services
handleRoutes(server);
handleRoutes(serverHTTP);

initSocketService(server); // Attach WebSocket to secure server
initSocketService(serverHTTP); // Attach WebSocket to non-secure server

initOrderbookService();
initMarketsService();

// Start the secure server (HTTPS)
server
    .listen(SERVER_PORT, '0.0.0.0')
    .then(() => {
        console.log(`Secure Server Started: https://localhost:${SERVER_PORT}`);
    })
    .catch((error) => {
        console.error('Error starting secure server:', error.message);
        process.exit(1);
    });

// Start the non-secure server (HTTP)
serverHTTP
    .listen(HTTP_PORT, '0.0.0.0')
    .then(() => {
        console.log(`Non-Secure Server Started: http://localhost:${HTTP_PORT}`);
    })
    .catch((error) => {
        console.error('Error starting non-secure server:', error.message);
        process.exit(1);
    });
