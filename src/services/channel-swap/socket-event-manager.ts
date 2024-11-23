// socket-event-manager.ts
import { Websocket } from 'hyper-express';

type EventHandler = (data: any) => void;

export class SocketEventManager {
    private eventHandlers: Map<string, Set<EventHandler>> = new Map();
    private messageListener: (message: string | ArrayBuffer) => void;

    constructor(public socket: Websocket) {
        this.messageListener = this.handleMessage.bind(this);
        this.socket.on('message', this.messageListener);
    }

    private handleMessage(message: string | ArrayBuffer) {
        const parsedMessage = JSON.parse(message as string);
        const { event, data } = parsedMessage;

        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.forEach(handler => handler(data));
        }
    }

    on(event: string, handler: EventHandler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
    }

    off(event: string, handler: EventHandler) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.eventHandlers.delete(event);
            }
        }
    }

    send(event: string, data: any) {
        this.socket.send(JSON.stringify({ event, data }));
    }

    close() {
        // Clean up event handlers
        this.eventHandlers.clear();
        // Remove the main message listener
        this.socket.removeListener('message', this.messageListener);
    }
}
