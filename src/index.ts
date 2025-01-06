import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const SERVER_PORT = envConfig.HTTP_PORT || 9191; // Default HTTP port

// Create Fastify HTTP server
const server = Fastify({ logger: true });

// Initialize routes and services
handleRoutes(server);
initSocketService(server);
initOrderbookService();
initMarketsService();

// Start HTTP server
server
    .listen(SERVER_PORT, '0.0.0.0')
    .then(() => {
        console.log(`Server running on http://localhost:${SERVER_PORT}`);
    })
    .catch((err) => {
        console.error('Error starting HTTP server:', err.message);
        process.exit(1);
    });
