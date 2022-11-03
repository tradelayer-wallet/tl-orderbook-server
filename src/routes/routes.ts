import { FastifyInstance } from "fastify";
import { logsRoutes } from "./logs.route";
import { marketsRoutes } from "./markets.route";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(require('fastify-cors'));
    server.register(marketsRoutes, { prefix: '/markets' });
    server.register(logsRoutes, { prefix: '/logs' });
};
