import { FastifyInstance } from "fastify";
import { fastifyCorsOptions } from "../config/cors";
import { logsRoutes } from "./logs.route";
import { marketsRoutes } from "./markets.route";

export const handleRoutes = (server: FastifyInstance) => {
    // CORS policy is decided in config/cors.ts (shared with the socket.io handshake).
    server.register(require('fastify-cors'), fastifyCorsOptions);
    server.register(marketsRoutes, { prefix: '/markets' });
    server.register(logsRoutes, { prefix: '/logs' });
};
