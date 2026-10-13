import { FastifyInstance } from "fastify";
import { envConfig } from "../config/env.config";
import { logsRoutes } from "./logs.route";
import { marketsRoutes } from "./markets.route";

export const handleRoutes = (server: FastifyInstance) => {
    // CORS origins come from CORS_ORIGINS. By default the allowlist covers the
    // origins the shipped wallet FE actually sends: `null` (the Electron UI is
    // loaded from file://) and the layerwallet.com web origins — the same policy
    // as the wallet's own socket.io server. Set CORS_ORIGINS (comma-separated) to
    // override, or CORS_ORIGINS=off to deny all cross-origin access.
    const corsOptions: any = envConfig.CORS_ORIGINS.length
        ? { origin: envConfig.CORS_ORIGINS }
        : { origin: false };
    server.register(require('fastify-cors'), corsOptions);
    server.register(marketsRoutes, { prefix: '/markets' });
    server.register(logsRoutes, { prefix: '/logs' });
};
