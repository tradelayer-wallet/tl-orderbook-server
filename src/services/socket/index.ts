import { FastifyInstance } from "fastify";
import { SocketManager } from "./manager.class";

export const initSocketService = (server: FastifyInstance) => {
    socketService = new SocketManager(server);
};

export let socketService: SocketManager;