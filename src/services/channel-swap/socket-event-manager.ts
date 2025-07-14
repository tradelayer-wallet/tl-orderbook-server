import { Websocket } from 'hyper-express';

/** Public handler type so ChannelSwap can import it */
export type EventHandler = (data: any) => void;

export class SocketEventManager {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly onMessage = this.handleMessage.bind(this);

  constructor(public socket: Websocket) {
    socket.on('message', this.onMessage);
  }

  /* ---------------- private ---------------- */
  private handleMessage(raw: string | ArrayBuffer) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw as string);
    } catch (e) {
      console.error('[SEM] JSON parse error', e);
      return;
    }
    const { event, data } = parsed;
    const set = this.handlers.get(event);
    if (set) set.forEach(h => h(data));
  }

  /* ---------------- public helpers ---------------- */
  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler) {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (!set.size) this.handlers.delete(event);
    }
  }

  /** Alias `emit` like in Socket.IO for familiarity */
  emit(event: string, data: any) {
    this.socket.send(JSON.stringify({ event, data }));
  }

  /** Clean‑up */
  dispose() {
    this.handlers.clear();
    this.socket.removeListener('message', this.onMessage);
  }
}
