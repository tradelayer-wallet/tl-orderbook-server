import { FastifyInstance } from "fastify";
import { Socket } from "socket.io";
import { SocketManager } from "./manager.class";

export const initSocketService = (server: FastifyInstance) => {
    socketService = new SocketManager(server);
};

export let socketService: SocketManager;

// The one liveness check for a socket id: the socket is connected right now.
// A socket is removed from the server's registry before its 'disconnect' handlers
// run, so a disconnected socket is never returned here.
export const getConnectedSocket = (socketId: string): Socket | undefined => {
    const socket = socketService?.io.sockets.sockets.get(socketId);
    return socket && socket.connected ? socket : undefined;
};