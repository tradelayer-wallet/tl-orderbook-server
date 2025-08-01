// src/index.ts
import HyperExpress from 'hyper-express';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const PORT = envConfig.SERVER_PORT || 3001;

// Initialize services with the server instance
handleRoutes(server);
initSocketService(server);
initOrderbookService();
initMarketsService();


const WSS_PORT = 443; // or whatever, but 443 is the browser default for WSS
const server = new HyperExpress.Server({
  key_file_name: '/home/ubuntu/ssl/privkey.pem',
  cert_file_name: '/home/ubuntu/ssl/fullchain.pem',
});

server.ws('/ws', (ws) => {
  ws.on('message', msg => { /* handle it */ });
  ws.on('close', () => { /* cleanup */ });
});

server.listen(WSS_PORT, '0.0.0.0').then(() => {
  console.log(`[WSS] listening on wss://yourdomain.com/ws`);
});