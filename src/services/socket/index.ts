import { FastifyInstance } from "fastify";
import { SocketManager } from "./manager.class";

export const initSocketService = async (servers: FastifyInstance[]) => {
    await SocketManager.init(servers);
};

export let socketService: SocketManager;
