// src/index.ts
import HyperExpress from 'hyper-express';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const PORT = envConfig.SERVER_PORT || 3010;

// Initialize HyperExpress server
const server = new HyperExpress.Server();

// Initialize services with the server instance
handleRoutes(server);
initSocketService(server);
initOrderbookService();
initMarketsService();

// Start the HyperExpress server
server.listen(PORT, '0.0.0.0')
    .then(() => {
        console.log(`Server Started: http://localhost:${PORT}`);
    })
    .catch((error) => {
        console.error('Error starting server:', error);
        process.exit(1);
    });
