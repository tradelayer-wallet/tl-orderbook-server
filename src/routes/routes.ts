import { FastifyInstance } from "fastify";
import { envConfig } from "../config/env.config";
import { logsRoutes } from "./logs.route";
import { marketsRoutes } from "./markets.route";

export const handleRoutes = (server: FastifyInstance) => {
    // CORS is deny-all for cross-origin requests by default (origin: false).
    // Only the origins listed in CORS_ORIGINS (comma-separated) are allowed.
    const corsOptions: any = envConfig.CORS_ORIGINS.length
        ? { origin: envConfig.CORS_ORIGINS }
        : { origin: false };
    server.register(require('fastify-cors'), corsOptions);
    server.register(marketsRoutes, { prefix: '/markets' });
    server.register(logsRoutes, { prefix: '/logs' });
};
