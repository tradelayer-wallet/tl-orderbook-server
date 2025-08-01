import HyperExpress from 'hyper-express';
import { initSocketService } from './services/socket';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

const WS_PORT = parseInt(process.env.WS_PORT || '3002', 10);

const wsServer = new HyperExpress.Server();

// Health
wsServer.get('/healthz', (req, res) => res.send('ok'));

// Core services
initOrderbookService();
initMarketsService();

// SocketManager attaches BOTH '/' and '/ws' on this server
initSocketService([wsServer]);

wsServer.listen(WS_PORT, '0.0.0.0')
  .then(() => console.log(`[WS] listening: ws://0.0.0.0:${WS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WS] failed:', e?.message || e); process.exit(1); });
