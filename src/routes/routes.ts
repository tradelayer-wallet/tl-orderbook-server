import { FastifyInstance } from "fastify";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(require('fastify-cors'));
}