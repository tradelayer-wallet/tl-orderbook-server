import HyperExpress from 'hyper-express';
import { SocketManager } from './manager.class';

let socketManager: SocketManager | undefined;

export function initSocketService(server: HyperExpress.Server) {
    socketManager = new SocketManager(server);   // ← Pass the server!
    console.log('Socket Service Initialized');
    return socketManager;
}

export function getSocketManager() {
    if (!socketManager) throw new Error('SocketManager not initialized');
    return socketManager;
}
