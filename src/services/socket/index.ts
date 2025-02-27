import HyperExpress from 'hyper-express';
import { SocketManager } from './manager.class';

export let socketManager: SocketManager;

export function initSocketService(server: HyperExpress.Server) {
    // Initialize SocketManager with the HyperExpress server
    socketManager = new SocketManager(server);
}