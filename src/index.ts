import * as fs from 'fs';
import HyperExpress from 'hyper-express';
import Fastify, { FastifyInstance } from 'fastify';
import { Server as IOServer } from 'socket.io';
import WebSocket from 'ws';

import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';

/* ========= ENV / PORTS =========
   Bots/desktop connect directly to HyperExpress :3002
   Web hits Fastify on 443 (TLS) OR 3001 (behind NGINX)
================================= */
const HEX_WS_PORT = parseInt(process.env.OB_WS_PORT || '3002', 10);

// Fastify mode:
// - TLS on 443 when OB_TLS=1 (Node serves HTTPS itself)
// - HTTP on OB_HTTP_PORT (default 3002) when OB_TLS=0 (behind NGINX)
const TLS_ENABLED = process.env.OB_TLS === '1';
const FASTIFY_HTTP_PORT = parseInt(process.env.OB_HTTP_PORT || '3001', 10);
const FASTIFY_HTTPS_PORT = parseInt(process.env.OB_HTTPS_PORT || '443', 10);
const TLS_KEY = process.env.OB_TLS_KEY_FILE || '/home/ubuntu/ssl/privkey.pem';
the const TLS_CERT = process.env.OB_TLS_CERT_FILE || '/home/ubuntu/ssl/fullchain.pem';

/* ========= CORE SERVICES (singletons) ========= */
initOrderbookService();
initMarketsService();

/* ========= HYPEREXPRESS: native WS for NPM/bots/desktop ========= */
const hex = new HyperExpress.Server();

// attach native WS handlers on both "/" and "/ws"
function attachNativeWs(app: HyperExpress.Server) {
  const onConn = (ws: HyperExpress.Websocket) => {
    // TODO: wire to your orderbook manager
    ws.on('message', (raw) => {
      // handle inbound messages
    });
    ws.on('close', () => {
      // cleanup
    });
  };
  app.ws('/', (ws) => onConn(ws));
  app.ws('/ws', (ws) => onConn(ws));

  // (optional) health check
  app.get('/healthz', (req, res) => res.send('ok'));
}

attachNativeWs(hex);

hex.listen(HEX_WS_PORT, '0.0.0.0')
  .then(() => {
    console.log(`[HyperExpress] WS on :${HEX_WS_PORT} -> ws://<host>:${HEX_WS_PORT}/ and /ws`);
  })
  .catch((e) => {
    console.error('[HyperExpress] failed to start:', e.message);
    process.exit(1);
  });

/* ========= FASTIFY: REST + Socket.IO for web ========= */
function makeFastify(): FastifyInstance {
  if (TLS_ENABLED) {
    return Fastify({
      logger: true,
      https: {
        key: fs.readFileSync(TLS_KEY),
        cert: fs.readFileSync(TLS_CERT),
      },
    });
  }
  return Fastify({ logger: true });
}

const fastify = makeFastify();

// REST routes (your existing ones)
handleRoutes(fastify as any);

// (optional) health
fastify.get('/healthz', async () => 'ok');

// Socket.IO relay attaches to Fastify's underlying server
function attachSocketIO(app: FastifyInstance) {
  const io = new IOServer(app.server, {
    transports: ['websocket'],
    path: '/socket.io/',
    cors: { origin: true, credentials: true },
  });

  const BACKEND_WS_URL = `ws://127.0.0.1:${HEX_WS_PORT}/ws`;
  let backend: WebSocket;

  const connectBackend = () => {
    if (backend && backend.readyState === WebSocket.OPEN) return;
    backend = new WebSocket(BACKEND_WS_URL);

    backend.on('open', () => {
      app.log.info({ msg: '[SIO-Relay] backend connected', BACKEND_WS_URL });
      io.emit('relay_status', { backend: 'connected' });
    });

    backend.on('message', (data) => {
      io.emit('ob', typeof data === 'string' ? data : data.toString());
    });

    backend.on('close', () => {
      app.log.warn('[SIO-Relay] backend closed; reconnect in 1s');
      io.emit('relay_status', { backend: 'closed' });
      setTimeout(connectBackend, 1000);
    });

    backend.on('error', (err) => {
      app.log.error({ msg: '[SIO-Relay] backend error', err: err.message });
    });
  };

  connectBackend();

  io.on('connection', (socket) => {
    app.log.info({ msg: '[SIO-Relay] client connected', id: socket.id });
    socket.emit('relay_status', {
      backend: backend && backend.readyState === WebSocket.OPEN ? 'connected' : 'connecting',
    });

    socket.on('send', (payload) => {
      try {
        const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (backend && backend.readyState === WebSocket.OPEN) backend.send(msg);
      } catch (e: any) {
        app.log.error({ msg: '[SIO-Relay] send failed', err: e.message });
      }
    });

    socket.on('disconnect', () => {
      app.log.info({ msg: '[SIO-Relay] client disconnected', id: socket.id });
    });
  });
}

/* start Fastify then attach Socket.IO */
(async () => {
  try {
    if (TLS_ENABLED) {
      await fastify.listen({ port: FASTIFY_HTTPS_PORT, host: '0.0.0.0' });
      fastify.log.info(`[Fastify] HTTPS on :${FASTIFY_HTTPS_PORT}`);
    } else {
      await fastify.listen({ port: FASTIFY_HTTP_PORT, host: '0.0.0.0' });
      fastify.log.info(`[Fastify] HTTP on :${FASTIFY_HTTP_PORT} (behind NGINX)`);
    }
    attachSocketIO(fastify);
    fastify.log.info('[Fastify] Socket.IO path /socket.io/');
  } catch (err: any) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
