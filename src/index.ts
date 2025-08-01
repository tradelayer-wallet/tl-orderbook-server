// src/index.ts
import * as fs from 'fs';
import Fastify from 'fastify';
import { handleRoutes } from './routes/routes';
import { envConfig } from './config/env.config';
import { initOrderbookService } from './services/orderbook';
import { initMarketsService } from './services/markets';
// If your web stack uses Socket.IO via Fastify, keep whatever you had before.
// Do NOT import the HyperExpress socket manager here.

const HTTPS_PORT = 443;
const HTTP_PORT  = envConfig.SERVER_PORT || 3001; // you said 3001 for HTTP

// TLS files for Fastify (web over HTTPS)
const SECURE_OPTIONS = {
  key:  fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
};

// 1) HTTPS Fastify
const serverHTTPS = Fastify({ logger: true, https: SECURE_OPTIONS });

// 2) HTTP Fastify (optional)
const serverHTTP  = Fastify({ logger: true });

// Register your existing web routes on BOTH Fastify servers
// NOTE: cast to `any` because handleRoutes is typed for HyperExpress.
handleRoutes(serverHTTPS as any);
handleRoutes(serverHTTP  as any);

// Initialize shared services (as in your original file)
initOrderbookService();
initMarketsService();

// Start both Fastify servers (web)
Promise.all([
  serverHTTPS.listen({ port: HTTPS_PORT, host: '0.0.0.0' }),
  serverHTTP.listen({ port: HTTP_PORT,  host: '0.0.0.0' }),
])
  .then(() => {
    console.log('WEB: Fastify HTTPS/HTTP up');
  })
  .catch((err) => {
    console.error('WEB init error:', err?.message || err);
    process.exit(1);
  });
