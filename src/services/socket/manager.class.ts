// Single point of truth for WS fan-out.
// - One bus handler per WS (no multiplicity)
// - Per-WS market subscriptions in a Set
// - Clean removal on close
// - Minimal API for OrderbookManager to emit messages

import HyperExpress from 'hyper-express';

type Json = Record<string, any>;

export class SocketManager {
  private _liveSessions = new Map<string, HyperExpress.Websocket>(); // id -> ws
  private _sessionSubs = new Map<string, Set<string>>();             // id -> Set<marketKey>
  private _attached    = new WeakSet<HyperExpress.Websocket>();      // guard
  private _recentClose = new Map<string, Map<string, number>>();     // id -> (uuid -> ts)

  constructor(private wss: HyperExpress.WebsocketServer) {}

  // === Public API for OrderbookManager =======================================
  toMarket(marketKey: string, payload: Json) {
    // cheap iteration: check subscription set per socket
    for (const [id, ws] of this._liveSessions) {
      const subs = this._sessionSubs.get(id);
      if (!subs || !subs.has(marketKey)) continue;
      this._safeSend(ws, payload);
    }
  }

  toSocketId(socketId: string, payload: Json) {
    const ws = this._liveSessions.get(socketId);
    if (ws) this._safeSend(ws, payload);
  }

  toAll(payload: Json) {
    for (const [, ws] of this._liveSessions) this._safeSend(ws, payload);
  }
  // ==========================================================================

  attach() {
    this.wss.on('connection', (ws) => {
      (ws as any).id = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
      const id = (ws as any).id as string;

      this.addSession(id, ws);
      ws.on('message', (raw) => this.handleMessage(ws, raw));
      ws.once('close', () => this.removeSession(id));
    });
  }

  // --- session wiring --------------------------------------------------------
  private addSession(id: string, ws: HyperExpress.Websocket) {
    this._liveSessions.set(id, ws);
    if (this._attached.has(ws)) return;
    this._attached.add(ws);
    this._sessionSubs.set(id, this._sessionSubs.get(id) ?? new Set<string>());

    // Single, long-lived relay for book-delivered events (if you later add internal bus)
    (ws as any)._busHandlers = {}; // placeholder for symmetry; nothing to attach right now
  }

  private removeSession(id: string) {
    const ws = this._liveSessions.get(id);
    this._liveSessions.delete(id);

    // detach any future bus handlers here if you add them:
    if (ws && (ws as any)._busHandlers) {
      // example: this.bus.off('evt', (ws as any)._busHandlers.onEvt);
      (ws as any)._busHandlers = undefined;
      this._attached.delete(ws);
    }

    this._sessionSubs.delete(id);
    this._recentClose.delete(id);
  }
  // --------------------------------------------------------------------------

  // --- client message router (JOIN/LEAVE, ORDER ops) ------------------------
  private async handleMessage(ws: HyperExpress.Websocket, message: ArrayBuffer | string) {
    let data: any;
    try {
      data = JSON.parse(typeof message === 'string' ? message : Buffer.from(message).toString());
    } catch (e) {
      console.error('[SM] Failed to parse WS message', e);
      return;
    }

    const id = (ws as any).id as string;
    switch (data.event) {
      case 'ORDERBOOK_JOIN': {
        const mk = String(data.marketKey ?? '');
        if (!mk) break;
        const subs = this._sessionSubs.get(id);
        if (subs && !subs.has(mk)) subs.add(mk);
        break;
      }
      case 'ORDERBOOK_LEAVE': {
        const mk = String(data.marketKey ?? '');
        if (!mk) break;
        this._sessionSubs.get(id)?.delete(mk);
        break;
      }
      // You can pass NEW_ORDER / CLOSE_ORDER up to an injected handler if you want,
      // or keep your existing path that calls OrderbookManager directly from wherever you parse app-level msgs.
      default:
        // no-op here; higher layer handles trading ops
        break;
    }
  }
  // --------------------------------------------------------------------------

  // --- helpers ---------------------------------------------------------------
  private _safeSend(ws: HyperExpress.Websocket, payload: Json) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  seenClose(ws: HyperExpress.Websocket, uuid: string, ttlMs = 3_000): boolean {
    const id = (ws as any).id as string;
    let map = this._recentClose.get(id);
    const now = Date.now();
    if (!map) this._recentClose.set(id, (map = new Map()));

    const ts = map.get(uuid);
    if (ts && now - ts < ttlMs) return true;

    map.set(uuid, now);
    if (map.size > 5000) {
      for (const [u, t] of map) if (now - t > ttlMs) map.delete(u);
    }
    return false;
  }
  // --------------------------------------------------------------------------
}

// Lightweight notifier the OM can hold
export interface ISocketNotifier {
  toMarket(marketKey: string, payload: Json): void;
  toSocketId(socketId: string, payload: Json): void;
  toAll(payload: Json): void;
}
