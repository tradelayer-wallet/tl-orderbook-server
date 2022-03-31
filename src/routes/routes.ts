import { FastifyInstance } from "fastify";
import { marketsRoutes } from "./markets.route";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(require('fastify-cors'));
    server.register(marketsRoutes, { prefix: '/markets' });
}