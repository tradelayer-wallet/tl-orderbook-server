import HyperExpress from 'hyper-express';
import { SocketManager } from './manager.class';

const app = new HyperExpress.Server();

export let socketManager: SocketManager;
/**
 * Initialise sockets on one *or many* HyperExpress servers.
 */
export function initSocketService(servers: HyperExpress.Server | HyperExpress.Server[]) {
  const list = Array.isArray(servers) ? servers : [servers];
  socketManager = new SocketManager(list);
  console.log('Socket service initialised on', list.length, 'listener(s)');
}