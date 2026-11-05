import HyperExpress from 'hyper-express';
import { handleRoutes } from './routes/routes';
import { socketManager } from './services/socket/'; // Import directly!
import { initMarketsService } from './services/markets';

// Listener configuration. Defaults are the production layout (plain ws on 3001 for desktop/NPM,
// wss on 443 for web, both on all interfaces); each part is overridable:
//   TL_OB_BIND       interface to bind (default 0.0.0.0; use 127.0.0.1 for local runs)
//   TL_OB_WS_PORT    plain listener port (default 3001)
//   TL_OB_WSS_PORT   TLS listener port (default 443); 0 disables the TLS listener
//   TL_OB_SSL_KEY / TL_OB_SSL_CERT   PEM paths for the TLS listener
const BIND      = process.env.TL_OB_BIND || '0.0.0.0';
const WS_PORT   = process.env.TL_OB_WS_PORT  !== undefined ? Number(process.env.TL_OB_WS_PORT)  : 3001;
const WSS_PORT  = process.env.TL_OB_WSS_PORT !== undefined ? Number(process.env.TL_OB_WSS_PORT) : 443;
const SSL_KEY   = process.env.TL_OB_SSL_KEY  || '/home/ubuntu/ssl/privkey.pem';
const SSL_CERT  = process.env.TL_OB_SSL_CERT || '/home/ubuntu/ssl/fullchain.pem';

// 1. Plain listener (desktop/NPM). REST (/markets, /logs, /auth) is served on every listener.
const servers: HyperExpress.Server[] = [new HyperExpress.Server()];
let wssServer: HyperExpress.Server | null = null;
if (WSS_PORT > 0) {
  wssServer = new HyperExpress.Server({ key_file_name: SSL_KEY, cert_file_name: SSL_CERT });
  servers.push(wssServer);
}
const wsServer = servers[0];

servers.forEach((srv) => handleRoutes(srv));

// Initialize shared core services ONCE
initMarketsService();

// Attach the same SocketManager to every server. The upgrade handler hands the request's headers and
// query string to handleOpen, which is where the bot API key (TL_OB_BOT_KEYS) is checked.
servers.forEach((srv) => {
  socketManager.attachServer(srv);  // enables uWS topic publish for market fan-out
  for (const path of ['/', '/ws']) {  // legacy/flex clients use either
    srv.upgrade(path, (req, res) => {
      res.upgrade({ headers: req.headers, query: req.query_parameters });
    });
    srv.ws(path, (ws) => socketManager.handleOpen(ws, (ws as any).context));
  }
});

console.log('[Init] SocketManager attached to all listeners');

// ---- Start WS (no SSL) ----
wsServer.listen(WS_PORT, BIND)
  .then(() => console.log(`[WS] listening on ws://${BIND}:${WS_PORT}/ws (and /)`))
  .catch((e) => { console.error('[WS] failed:', e?.message || e); process.exit(1); });

// ---- Start WSS (with SSL) ----
if (wssServer) {
  wssServer.listen(WSS_PORT, BIND)
    .then(() => console.log(`[WSS] listening on wss://${BIND}:${WSS_PORT}/ws (and /)`))
    .catch((e) => { console.error('[WSS] failed:', e?.message || e); process.exit(1); });
}
