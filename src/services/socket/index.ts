import HyperExpress from 'hyper-express';
import { SocketManager } from './manager.class';

const app = new HyperExpress.Server();

export let socketManager: SocketManager;

export function initSocketService(server: HyperExpress.Server) {
    // Initialize SocketManager with the HyperExpress server
    socketManager = new SocketManager(server);
    console.log('Socket Service Initialized');
}