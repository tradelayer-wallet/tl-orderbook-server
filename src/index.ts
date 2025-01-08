import * as fs from 'fs'; // Import fs for reading SSL certificates
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const HTTP_PORT = envConfig.HTTP_PORT || 9090;

// Create HTTP Fastify instance (default to HTTP)
const server = Fastify({ logger: true });

// Initialize routes and services
handleRoutes(server);
initSocketService(server);
initOrderbookService();
initMarketsService();

// Start HTTP server
server
    .listen(HTTP_PORT, '0.0.0.0') // Bind to 9191
    .then(() => {
        console.log(`Non-secure server running on http://localhost:${HTTP_PORT}`);
    })
    .catch((err) => {
        console.error('Error starting HTTP server:', err.message);
        process.exit(1);
    });
