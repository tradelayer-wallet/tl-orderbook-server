import { FastifyInstance } from "fastify";
import { Server, Socket } from "socket.io";
import { OnEvents } from "./events";

export class SocketManager {
    constructor(
        private server: FastifyInstance,
    ) {
        this.initService();
    }

    private get io(): Server {
        return this.server['io'];
    }

    private initService() {
        const fastifyIO = require("fastify-socket.io");
        this.server.register(fastifyIO);
        this.server.ready().then(() => {
            console.log(`Socket Service Initialized`);
            this.io.on(OnEvents.CONNECTION, onConnection);
        });
    }
}

const onConnection = (socket: Socket) => {
    console.log(`New Connection: ${socket.id}`);
    socket.on(OnEvents.DISCONNECT, onDisconnect(socket));
}

const onDisconnect = (socket: Socket) => (reason: string) => {
    console.log(`${socket.id} Disconnected! Reason: ${reason}`);
};