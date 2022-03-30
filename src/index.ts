import Fastify, { FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';

const PORT = envConfig.SERVER_PORT;
const OPTIONS: FastifyServerOptions = {};

const server = Fastify(OPTIONS);

handleRoutes(server);
initSocketService(server);
initOrderbookService();

server
    .listen(PORT, '0.0.0.0')
    .then((serverUrl) => {
        console.log(`Server Started: http://localhost:${PORT}`);
    })
    .catch((error) => {
        server.log.error(error.message);
        process.exit(1);
    });
