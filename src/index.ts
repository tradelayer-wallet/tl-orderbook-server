import * as fs from 'fs'; // Import fs for reading SSL certificates
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const SERVER_PORT = envConfig.SERVER_PORT || 443;
const HTTP_PORT = envConfig.HTTP_PORT || 9191;

// Load SSL certificates
const SECURE_OPTIONS = {
    key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
    cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// Create HTTPS Fastify instance
const server = Fastify({
    logger: true,
    https: SECURE_OPTIONS, // Attach HTTPS options here
});

// Create HTTP Fastify instance
const serverHTTP = Fastify({ logger: true });


// Initialize routes and services
handleRoutes(server);
initSocketService(server);

handleRoutes(serverHTTP);

initOrderbookService();
initMarketsService();

// Start HTTPS server
server
    .listen(SERVER_PORT, '0.0.0.0')
    .then(() => {
        console.log(`Secure server running on https://localhost:${SERVER_PORT}`);
    })
    .catch((err) => {
        console.error('Error starting HTTPS server:', err.message);
        process.exit(1);
    });

// Start HTTP server
/*serverHTTP
    .listen(HTTP_PORT, '0.0.0.0')
    .then(() => {
        console.log(`Non-secure server running on http://localhost:${HTTP_PORT}`);
    })
    .catch((err) => {
        console.error('Error starting HTTP server:', err.message);
        process.exit(1);
    });
*/
