// src/index.ts
import HyperExpress from 'hyper-express';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const PORT = envConfig.SERVER_PORT || 9191;

// Initialize HyperExpress server
const server = new HyperExpress.Server();

// Initialize services with the server instance
handleRoutes(server);
// Register a WebSocket route for clients (orderbook desktop/web wallets, etc)
server.ws('/ws', (ws) => {
    // Pass the ws connection to your socket service
    // This is where message/event routing happens
    initSocketService(ws);
});
initOrderbookService();
initMarketsService();

// Start the HyperExpress server
server.listen(PORT)
    .then(() => {
        console.log(`Server Started: http://localhost:${PORT}`);
    })
    .catch((error) => {
        console.error('Error starting server:', error);
        process.exit(1);
    });
