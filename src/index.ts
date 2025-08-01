import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
import { initSocketService } from './services/socket';

const HTTPS_PORT = 443;
const HTTP_PORT = envConfig.SERVER_PORT || 9191;

const SECURE_OPTIONS = {
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });
const serverHTTP  = Fastify({ logger: true });

// Your routes exactly as before
handleRoutes(serverHTTPS);
handleRoutes(serverHTTP);

initOrderbookService();
initMarketsService();

// If your web uses Socket.IO via Fastify, keep your existing initSocketService here (if needed)
// await initSocketService([...])  // only if your web side needs it

Promise.all([
  serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' }),
  serverHTTP.listen({ port: HTTP_PORT,  host: '0.0.0.0' }),
])
.then(() => console.log('WEB: Fastify HTTPS/HTTP up'))
.catch((err) => { console.error(err); process.exit(1); });
