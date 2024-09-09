import Fastify, { FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const PORT = envConfig.SERVER_PORT || 9191;
const OPTIONS: FastifyServerOptions = {};

const server = Fastify(OPTIONS);

handleRoutes(server);
initSocketService(server);
initOrderbookService();
initMarketsService();

server
    .listen(PORT, '0.0.0.0')
    .then((serverUrl) => {
        console.log(`Server Started: http://localhost:${PORT}`);
    })
    .catch((error) => {
        console.log({error})
        server.log.error(error.message);
        process.exit(1);
    });
