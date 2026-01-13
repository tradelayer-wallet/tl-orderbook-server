// ---------- imports ----------
import HyperExpress from 'hyper-express';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { native, registerNativeSinks, JsOrder, Exec } from '../../native';
import { ChannelSwap } from "../channel-swap/channel-swap.class";
import { getSessionForToken } from '../routes/auth.route'; // adjust path to your repo layout


import {
  ITradeInfo,
  TOrder,
  EOrderType,
  EOrderAction,
  ISpotOrderProps,
  IFuturesOrderProps,
} from '../../utils/types/orderbook.types';

type WS = HyperExpress.Websocket;
type UUID = string;

// -----------------------------------------------------------------------------
// Polymorphic Auth: Client Classification
// -----------------------------------------------------------------------------
/**
 * ClientClass determines auth requirements:
 * - 'web': browser clients, MUST session-auth before mutations
 * - 'desktop': trusted via timed key decrypt, exempt from session auth
 * - 'bot': server-side trust via API key/allowlist, exempt from session auth
 */
type ClientClass = 'web' | 'desktop' | 'bot';

type SessionRecord = {
  address: string;
  expiresAt: number;
};

// Extend WS type to include our auth metadata
interface AuthenticatedWS extends HyperExpress.Websocket {
  id: string;
  _markets: Set<string>;
  clientClass: ClientClass;
  authed: boolean;
  session: SessionRecord | null;
  traderAddress?: string; // resolved identity for order binding
}

const MUTATING_EVENTS = new Set<string>([
  OnEvents.NEW_ORDER,
  OnEvents.MANY_ORDERS,
  OnEvents.AMEND_ORDER,
  OnEvents.CLOSE_ORDER,
  'close-order',
]);


export type OrderAction = 'BUY' | 'SELL';
export type OrderTypeKind = 'SPOT' | 'FUTURES';

const toEOrderType = (t: unknown): EOrderType => {
  if (t === EOrderType.FUTURES || t === 'FUTURES') return EOrderType.FUTURES;
  return EOrderType.SPOT;
};

export interface IResult<T> { data?: T; error?: string }
export interface IResultChannelSwap extends IResult<{ txid: string }> {}

export function safeNumber(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

interface IHistoryTrade extends ITradeInfo {
  txid: string;
  time: number;
}

type NormalizedOrder = {
  uuid: string;
  socketId: string;
  traderAddress?: string; // bound identity from session
  price: number;
  amount: number;
  side: 'BUY' | 'SELL';
  type?: 'SPOT' | 'FUTURES';
  action?: 'BUY' | 'SELL';
  props?: any;
  keypair?: any;
  error?: string;
};

const PRICE_SCALE = 100;   // engine ticks -> UI price
const QTY_SCALE   = 1e8;   // engine sats  -> UI amount

// Polyfill for queueMicrotask if needed
if (typeof (global as any).queueMicrotask !== 'function') {
  (global as any).queueMicrotask = (fn: () => void) => Promise.resolve().then(fn);
}

// --- helpers ---
// ---- exec/snapshot wiring (strict) ------------------------------------------

type WireSinks = {
  onExecs?: (symbol: string, execs: any[]) => void;
  onSnapshot?: (symbol: string, snapshot: any) => void;
};

const looksLikeJsonArray = (s: unknown) =>
  typeof s === 'string' && /^\s*\[/.test(s);

const parseArrayStrict = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (looksLikeJsonArray(v)) {
    return JSON.parse(v as string);
  }
  throw new Error(`[exec] expected array (or JSON string array), got ${typeof v}`);
};

let _loggedProbeOnce = false;

/**
 * Strictly wire native (preferred) or shim (fallback) exec/snapshot sinks.
 * Fails loud on wrong types to surface mis-wiring immediately.
 */
export const wireExecSinksStrict = (
  nativeObj: any,
  registerNativeSinksFn: (s: WireSinks) => void,
  sinks: WireSinks
) => {
  const { setExecSink, setSnapshotSink, nativeBuildId } = nativeObj ?? {};
  if (typeof nativeBuildId === 'function') {
    try { console.log('[native build]', nativeBuildId()); } catch {}
  }

  const hasNativeExecs = typeof setExecSink === 'function';

  // Prefer native
  if (hasNativeExecs && typeof sinks.onExecs === 'function') {
    setExecSink((symbol: string, execsJson: string) => {
      // legacy probe tolerance still OK but should never hit now
      // (kept for safety; delete if you want)
      if ((symbol as any) == null && typeof execsJson === 'string') {
        if (!_loggedProbeOnce) {
          console.warn('[exec] (null, symbol) probe; ignoring once:', execsJson);
          _loggedProbeOnce = true;
        }
        return;
      }

      if (typeof symbol !== 'string') {
        throw new Error(`[exec] expected symbol:string, got ${typeof symbol}`);
      }

      try {
        const arr = JSON.parse(execsJson);
        if (Array.isArray(arr) && arr.length) {
          sinks.onExecs!(symbol, arr);
        }
      } catch (e) {
        console.error('[exec parse error]', e);
      }
    });
  }

  if (typeof setSnapshotSink === 'function' && typeof sinks.onSnapshot === 'function') {
    setSnapshotSink((symbol: unknown, snapshot: unknown) => {
      if (typeof symbol !== 'string') {
        throw new Error(`[snapshot] expected symbol:string, got ${typeof symbol}`);
      }
      const obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      queueMicrotask(() => sinks.onSnapshot!(symbol, obj));
    });
    console.log('[sinks] addon snapshot wired (STRICT)');
  }

  // Fallback shim only if native exec sink is missing
  if (!hasNativeExecs) {
    registerNativeSinksFn({
      onExecs: (symbol: unknown, execs: unknown) => {
        if (typeof symbol !== 'string') {
          throw new Error(`[shim exec] expected symbol:string, got ${typeof symbol}`);
        }
        const arr = parseArrayStrict(execs);
        queueMicrotask(() => sinks.onExecs?.(symbol, arr));
      },
      onSnapshot: (symbol: unknown, snapshot: unknown) => {
        if (typeof symbol !== 'string') {
          throw new Error(`[shim snap] expected symbol:string, got ${typeof symbol}`);
        }
        const obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
        queueMicrotask(() => sinks.onSnapshot?.(symbol, obj));
      },
    });
    console.log('[sinks] shim exec/snapshot wired (STRICT)');
  }
};

function parseMaybeJson<T = any>(x: unknown, fallback: T): T {
  if (x == null) return fallback;
  if (typeof x !== 'string') return x as T;
  try { return JSON.parse(x) as T; } catch { return fallback; }
}

export class SocketManager {
  private _liveSessions = new Map<string, WS>();
  private _marketSubs = new Map<string, Set<string>>();
  private _sessionSubs = new Map<string, Set<string>>();

  private _dirty = new Set<string>();
  private _flushing = false;
  private _coalesceMs = 50;
  private _depth = 40;

  private _recentClose = new Map<string, Map<string, number>>();
  private _uuidToMarket = new Map<string, string>();
  private _byUuid = new Map<string, { market: string; price?: number; quantity?: number }>();

  private _tickHandle: NodeJS.Timeout | null = null;
  private _lastNativeSnap = new Map<string, any>(); // marketKey -> latest snapshot

  constructor() {
    // periodic broadcaster
    this._tickHandle = setInterval(() => this.flushOrderbookData(), this._coalesceMs);

    // wire sinks (native preferred, shim fallback)
    wireExecSinksStrict(native as any, registerNativeSinks, {
      onExecs: (symbol, execs) => this._handleExecs(symbol, execs),
      onSnapshot: (symbol, snapshot) => {
        this._lastNativeSnap.set(symbol, snapshot);
        this._dirty.add(symbol);
      }
    });
  }

  /** 
   * Network-aware market key builder
   * Appends network suffix to market key before passing to Rust
   * Examples: "5-4" + "LTCTEST" -> "5-4-LTCTEST"
   *           "BTC-USD-perp" + "MAINNET" -> "BTC-USD-perp-MAINNET"
   */
  private makeInternalKey(market: string, network?: string): string {
    if (!network) return market;
    const suffix = network.toUpperCase();
    return `${market}-${suffix}`;
  }

  /**
   * Extract base market and network from internal key
   * Examples: "5-4-LTCTEST" -> { market: "5-4", network: "LTCTEST" }
   *           "BTC-USD-perp-MAINNET" -> { market: "BTC-USD-perp", network: "MAINNET" }
   */
  private parseInternalKey(internalKey: string): { market: string; network?: string } {
    // Known network suffixes (add more as needed)
    const knownNetworks = ['MAINNET', 'TESTNET', 'SIGNET', 'LTCTEST', 'REGTEST'];
    
    for (const net of knownNetworks) {
      if (internalKey.endsWith(`-${net}`)) {
        const market = internalKey.slice(0, -(net.length + 1));
        return { market, network: net };
      }
    }
    
    return { market: internalKey, network: undefined };
  }
    
  // Register a socket with its id
  add(id: string, ws: WS) {
    this._liveSessions.set(id, ws);
  }

  // Lookup by id
  get(id: string): WS | undefined {
    return this._liveSessions.get(id);
  }

  // Remove by id
  remove(id: string) {
    this._liveSessions.delete(id);
  }

  has(id: string): boolean {
    return this._liveSessions.has(id);
  }

  size(): number {
    return this._liveSessions.size;
  }

  private flushOrderbookData() {
     if (this._dirty.size === 0) return;
     const markets = Array.from(this._dirty);
     this._dirty.clear();
     for (const mk of markets) {
       const native = this._lastNativeSnap.get(mk);
       if (!native) continue;
       this.broadcastToMarket(mk, {
         event: EmitEvents.ORDERBOOK_DATA,
         marketKey: mk,
         native,
       });
     }
  }

  spotKeyFromIds(a?: any, b?: any): string | null {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const x = Number(a), y = Number(b);
      const base = Math.min(x, y);
      const quote = Math.max(x, y);
      return `${base}-${quote}`;            // canonical internal key
    }

  futKey(contractId?: any, expiry?: any): string | null {
    if (!contractId && !expiry) return null;
    const cid = String(contractId ?? '');
    const exp = expiry == null ? 'perp' : String(expiry);
    return `${cid}-${exp}`;
  }

  // minimal stub so the optional call compiles; wire to real storage later
  private saveToHistory(t: IHistoryTrade): void {
    // e.g., push to an in-memory array or forward to persistence
    // (left intentionally no-op for now)
  }

  // -----------------------------------------------------------------------------
  // Polymorphic Auth: Client Classification Detection
  // -----------------------------------------------------------------------------
  /**
   * Detect client class from upgrade request headers.
   * Called during handleOpen to classify the connection.
   */
  private detectClientClass(req?: any): { clientClass: ClientClass; authed: boolean; apiKey?: string } {
    // Default: web client, not authed
    let clientClass: ClientClass = 'web';
    let authed = false;
    let apiKey: string | undefined;

    if (!req?.headers) {
      return { clientClass, authed };
    }

    // Desktop detection: custom header from Electron/desktop app
    const desktopHeader = req.headers['x-tradelayer-client'];
    if (desktopHeader === 'desktop') {
      clientClass = 'desktop';
      authed = true; // trusted via desktop security (timed key decrypt)
      console.log('[Auth] Desktop client detected - exempt from session auth');
      return { clientClass, authed };
    }

    // Bot/NPM detection: API key header
    apiKey = req.headers['x-api-key'] || req.headers['x-tradelayer-api-key'];
    if (apiKey) {
      // TODO: validate API key against allowlist/database
      // For now, presence of key grants bot status
      clientClass = 'bot';
      authed = true; // server-side trust
      console.log('[Auth] Bot client detected - exempt from session auth');
      return { clientClass, authed, apiKey };
    }

    // Could also detect via query string for environments where headers are awkward
    // e.g., ws://host/ws?client=desktop or ws://host/ws?apiKey=xxx

    return { clientClass, authed };
  }

  /**
   * Resolve trader address based on client class:
   * - web: from session.address (must be session-authed)
   * - desktop: from decrypted keypair (passed in order data)
   * - bot: from API key -> account mapping
   */
  private resolveTraderAddress(ws: AuthenticatedWS, data?: any): string | undefined {
    switch (ws.clientClass) {
      case 'web':
        // Web clients MUST use session-bound address
        return ws.session?.address;
      
      case 'desktop':
        // Desktop: derive from keypair in order data, or cached on socket
        // The desktop app decrypts the key locally and includes the address
        return data?.address || data?.order?.address || data?.keypair?.address || ws.traderAddress;
      
      case 'bot':
        // Bot: lookup from API key -> account mapping
        // For now, allow explicit address in data (server validates elsewhere)
        return data?.address || data?.order?.address || ws.traderAddress;
      
      default:
        return undefined;
    }
  }

  // === Public API expected by index.ts ===
  /**
   * Handle new WebSocket connection.
   * Detects client class and initializes auth state.
   * 
   * @param ws - WebSocket instance
   * @param req - Optional upgrade request (for header access)
   */
  handleOpen = (ws: WS, req?: any) => {
    const id = this.generateUniqueId();
    const authWs = ws as AuthenticatedWS;
    
    // Basic socket setup
    authWs.id = id;
    authWs._markets = new Set<string>();
    
    // Polymorphic auth: detect client class from headers
    const { clientClass, authed, apiKey } = this.detectClientClass(req);
    authWs.clientClass = clientClass;
    authWs.authed = authed;
    authWs.session = null;
    
    // For bots, could store API key for later account resolution
    if (apiKey) {
      // TODO: resolve apiKey -> traderAddress from database
      // authWs.traderAddress = lookupAddressForApiKey(apiKey);
    }

    this._liveSessions.set(id, ws);

    ws.on('message', (m) => this.handleMessage(ws, m));
    ws.on('close', () => this.handleClose(ws));

    // Initial hello - include auth requirements based on client class
    const authRequired = clientClass === 'web' && !authed;
    ws.send(JSON.stringify({ 
      event: 'connected', 
      id,
      clientClass,
      authRequired,
      // Help client understand what they need to do
      ...(authRequired && { authHint: 'Send { event: "auth", token: "<sessionToken>" } before placing orders' })
    }));

    console.log(`[SM] OPEN ${id}, clientClass=${clientClass}, authed=${authed}, live=${this._liveSessions.size}`);
  };

  // === Event handlers ===
  private async handleMessage(ws: WS, message: ArrayBuffer | string) {
    const authWs = ws as AuthenticatedWS;
    let data: any;
    try {
      data = JSON.parse(
        typeof message === 'string'
          ? message
          : Buffer.from(message).toString()
      );
    } catch (e) {
      console.error('[SM] Failed to parse WS message', e, message);
      return;
    }
    
    console.log('incoming message ' + JSON.stringify(data));

    // -----------------------------------------------------------------------------
    // AUTH HANDSHAKE (web clients only)
    // -----------------------------------------------------------------------------
    if (data.event === 'auth') {
      // Auth is only meaningful for web clients
      if (authWs.clientClass !== 'web') {
        ws.send(JSON.stringify({ 
          event: 'auth_ignored', 
          message: `Auth not required for ${authWs.clientClass} clients` 
        }));
        return;
      }

      const token = String(data.token || '');
      if (!token) {
        ws.send(JSON.stringify({ 
          event: OrderEmitEvents.ERROR, 
          message: 'Missing token' 
        }));
        return;
      }

      const session = getSessionForToken(token);
      if (!session) {
        ws.send(JSON.stringify({ 
          event: OrderEmitEvents.ERROR, 
          message: 'Invalid or expired session' 
        }));
        return;
      }

      // Mark socket as authenticated
      authWs.authed = true;
      authWs.session = session;
      authWs.traderAddress = session.address;

      ws.send(JSON.stringify({ 
        event: 'auth_ok', 
        address: session.address, 
        expiresAt: session.expiresAt 
      }));
      
      console.log(`[Auth] Web client ${authWs.id} authenticated as ${session.address}`);
      return;
    }

    // -----------------------------------------------------------------------------
    // GATE MUTATIONS (web clients only)
    // -----------------------------------------------------------------------------
    if (MUTATING_EVENTS.has(data.event) && authWs.clientClass === 'web' && !authWs.authed) {
      ws.send(JSON.stringify({ 
        event: OrderEmitEvents.ERROR, 
        message: 'Authentication required (web client). Send { event: "auth", token } first.' 
      }));
      return;
    }

    // -----------------------------------------------------------------------------
    // STANDARD EVENT ROUTING
    // -----------------------------------------------------------------------------
    switch (data.event) {
      case OnEvents.NEW_ORDER: {
        await this.handleNewOrder(ws, data);
        break;
      }
      case OnEvents.UPDATE_ORDERBOOK: {
        this.handleUpdateOrderbook(ws, data);
        break;
      }
      case OnEvents.CLOSE_ORDER:
      case 'close-order': {
        const uuid = String(data.orderUUID || data.uuid || '');
        if (this._seenClose(ws, uuid)) break; // drop duplicate spam
        this.handleCloseOrder(ws, data);
        break;
      }
      case OnEvents.MANY_ORDERS: {
        await this.handleManyOrders(ws, data);
        break;
      }
      case OnEvents.AMEND_ORDER: {
      const uuid  = String(data.orderUUID || data.orderUuid || data.uuid || '');
      const network = data.network;
      const mk    = this.resolveMarket(data);
      const internalKey = this.makeInternalKey(mk, network);
      const newQty = data.newAmount ?? data.newQty;
      const newPx  = data.newPrice;

      if (!uuid || !mk) {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: !uuid ? 'Missing orderUUID' : 'Missing marketKey'
        }));
        break;
      }

      try {
        native.init_market?.(internalKey);
        // pass undefined for fields you aren't changing
        native.edit(
          internalKey,
          uuid,
          newQty != null ? Number(newQty) : undefined,
          newPx  != null ? Number(newPx)  : undefined
        );

        // optional ack
        ws.send(JSON.stringify({
          event: 'amended',
          orderUuid: uuid,
          marketKey: mk,
          newQty,
          newPrice: newPx
        }));

        // nudge clients to refresh the book / opened orders
        this.broadcastToMarket(internalKey, { event: EmitEvents.UPDATE_ORDERS_REQUEST, marketKey: mk });
      } catch (e: any) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: e?.message || 'amend failed' }));
      }
      break;
    }

      case OnEvents.ORDERBOOK_JOIN: {
        const network = data.network;
        const mk = this.resolveMarket(data)
        if (mk) this.subscribeMarket((ws as any).id, mk, ws, network);
        break;
      }
      case OnEvents.ORDERBOOK_LEAVE: {
        const network = data.network;
        const mk = String(data.marketKey ?? '') || '';
        if (mk) this.unsubscribeMarket((ws as any).id, mk, network);
        break;
      }
      case OnEvents.DISCONNECT: {
        this.sweepOrders((ws as any).id, 'client-disconnect');
        ws.close();
        break;
      }
      default: {
        console.log(`[SM] Unknown event type: ${data.event}`);
      }
    }
  }

  private async handleNewOrder(ws: HyperExpress.Websocket, data: any){
    const authWs = ws as AuthenticatedWS;
    
    //  1. Basic guards
    if (!data.isLimitOrder) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: 'Market Orders Not allowed'
      }));
      return;
    }

    // Extract network early
    const network = data.network || data.order?.network;

    // --- FUTURES normalization ---
    if (data?.type === 'FUTURES' && data?.props) {
      if (data.props.contractId && !data.props.contract_id) {
        data.props.contract_id = data.props.contractId;
        delete data.props.contractId;
      }
    }

    // --- SPOT normalization ---
    if (data?.type === 'SPOT' && data?.props) {
      const f = data.props.id_for_sale;
      const d = data.props.id_desired;
      if (f == null || d == null) {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Missing property IDs'
        }));
        return;
      }
      const baseId  = Math.min(f, d);
      const quoteId = Math.max(f, d);
      if (f === baseId && d === quoteId) data.props.side = 'BUY';
      else if (f === quoteId && d === baseId) data.props.side = 'SELL';
      else {
        ws.send(JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Invalid property ID pair'
        }));
        return;
      }
    }

    // 🧭 2. Resolve market
    const sid = (ws as any).id as string;
    const market = this.resolveMarket(data);
    
    // Create internal key with network suffix
    const internalKey = this.makeInternalKey(market, network);
    this.ensureSocketMarketIndex(sid, internalKey);
    
    if (!market) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: 'Missing marketKey'
      }));
      return;
    }

    // ⚙️ 3. Normalize & bind trader identity
    const order = this.normalizeOrder(data, sid) as NormalizedOrder;
    if (order.error) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: order.error }));
      return;
    }

    // IMPORTANT: Bind trader address based on client class
    // This prevents web clients from spoofing identity
    const traderAddress = this.resolveTraderAddress(authWs, data);
    order.traderAddress = traderAddress;
    
    // For web clients, override any client-supplied address
    if (authWs.clientClass === 'web' && authWs.session?.address) {
      if (order.props) {
        order.props.trader = authWs.session.address;
        order.props.address = authWs.session.address;
      }
    }

    console.log('order before sub ' + JSON.stringify(order) + ' and after toJs ' + JSON.stringify(this.toJsOrder(order)));
    
    try {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.SAVED,
        orderUuid: order.uuid
      }));

      // 🔧 4. Submit to native engine with internal key
      native.submit(internalKey, this.toJsOrder(order));

      // 🧩 5. Immediate placed-orders tray
      console.log('about to call orders ' + sid + ' ' + internalKey);
      try {
        const openedRaw = (native as any).get_open_orders_by_socket?.(sid, internalKey);
        console.log('fetched orders ' + JSON.stringify(openedRaw));

        const historyRaw = (native as any).getOrderHistoryBySocket?.(sid, internalKey);
        console.log('order history ' + JSON.stringify(historyRaw));

        const opened = typeof openedRaw === 'string'
          ? JSON.parse(openedRaw)
          : (Array.isArray(openedRaw) ? openedRaw : []);

        const orderHistory = typeof historyRaw === 'string'
          ? JSON.parse(historyRaw)
          : (Array.isArray(historyRaw) ? historyRaw : []);

        ws.send(JSON.stringify({
          event: EmitEvents.PLACED_ORDERS,
          openedOrders: opened,
          orderHistory
        }));
      } catch (err) {
        console.warn('[placed-orders err]', err);
      }

      // 📡 6. Broadcast snapshot to all subs
      
      const snapRaw = (native as any).snapshot?.(internalKey);

      console.log('market snapshot ' + JSON.stringify(snapRaw));

      const snapObj = typeof snapRaw === 'string'
        ? JSON.parse(snapRaw)
        : (snapRaw ?? null);

      // OPTIONAL: price scale normalization (engine ticks -> UI units)
      // If your engine stores price=100 but UI expects 1.00, set PRICE_SCALE accordingly.
      // Derive from market metadata if you have it.
      const normalized =
          snapObj && snapObj.snapshot
            ? {
                symbol: snapObj.snapshot.symbol,
                timestamp: snapObj.snapshot.timestamp,
                bids: (snapObj.snapshot.bids ?? []).map((b: any) => ({
                  price: PRICE_SCALE ? b.price / PRICE_SCALE : b.price,
                  amount: (b.visible_quantity ?? 0) / QTY_SCALE,  
                  count: b.order_count,
                })),
                asks: (snapObj.snapshot.asks ?? []).map((a: any) => ({
                  price: PRICE_SCALE ? a.price / PRICE_SCALE : a.price,
                  amount: (a.visible_quantity ?? 0) / QTY_SCALE,   
                  count: a.order_count,
                })),
                checksum: snapObj.checksum,
              }
            : null;
            this.broadcastToMarket(internalKey,{
            event: EmitEvents.ORDERBOOK_DATA,
            orders: normalized,
            isDelta: false,
            history: 0,
          });

      // Send a real object, not a string
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        orders: normalized,       // or snapObj if you don't want to reshape/scale
        isDelta: false,
        history: 0,
      }));
    } catch (e: any) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: e?.message || 'submit failed'
      }));
    }
  }

  private async handleManyOrders(ws: WS, data: any) {
    const authWs = ws as AuthenticatedWS;
    const sid = (ws as any).id as string;
    const network = data.network;
    const market = this.resolveMarket(data);
    const internalKey = this.makeInternalKey(market, network);
    this.ensureSocketMarketIndex(sid, internalKey);
    
    if (!market) {
      ws.send(
        JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: 'Missing marketKey',
        })
      );
      return;
    }

    const rawOrders: any[] = Array.isArray(data.orders) ? data.orders : [];
    const normalized = rawOrders.map((o) => {
      const norm = this.normalizeOrder(o, sid) as NormalizedOrder;
      
      // Bind trader address for each order
      norm.traderAddress = this.resolveTraderAddress(authWs, o);
      
      // For web clients, enforce session address
      if (authWs.clientClass === 'web' && authWs.session?.address) {
        if (norm.props) {
          norm.props.trader = authWs.session.address;
          norm.props.address = authWs.session.address;
        }
      }
      
      return norm;
    });


    try {
      // give per-order ACKs (client expects this)
      for (const o of normalized) {
        ws.send(
          JSON.stringify({ event: OrderEmitEvents.SAVED, orderUuid: o.uuid })
        );
      }

      const jsOrders = normalized.map((o) => this.toJsOrder(o));
      // If you have native.submit_batch you can use it; otherwise loop:
      for (const o of jsOrders) native.submit(internalKey, o);

      this.broadcastToMarket(internalKey, {
        event: EmitEvents.UPDATE_ORDERS_REQUEST,
      });
    } catch (e: any) {
      ws.send(
        JSON.stringify({
          event: OrderEmitEvents.ERROR,
          message: e?.message || 'batch submit failed',
        })
      );
    }
  }

  private handleCloseOrder(ws: WS, data: any) {
    const uuid = String(data.orderUUID || data.uuid || '');
    if (!uuid) return;

    const sid    = (ws as any).id as string;
    const network = data.network;
    const market = this.resolveMarket(data);
    const internalKey = this.makeInternalKey(market, network);
    console.log('uuid', uuid, internalKey);
    this.ensureSocketMarketIndex(sid, internalKey);

    if (!market) {
      console.warn('[close-order] missing marketKey for uuid', uuid);
      return;
    }

    try {
      // cancel on the engine
      (native as any).cancel?.(internalKey, uuid);
    } catch (e) {
      console.warn('[close-order] cancel error', e);
    }


    setTimeout(() => {
      console.log('sending snapshot after cancel')
      try {
        this.sendOrderbookSnapshot(ws, market, 50, network);
      } catch (e) {
        console.warn('[close-order] snapshot send error', e);
      }
    }, 1)
    // optionally re-broadcast fresh snapshot to this socket
  }

  // -----------------------------------------------------------------------------
  // STUB METHODS - These exist in the original file but were truncated
  // You'll need to copy these from your actual implementation
  // -----------------------------------------------------------------------------
  
  private generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private handleClose(ws: WS): void {
    const id = (ws as any).id;
    if (id) {
      this._liveSessions.delete(id);
      // Clean up market subscriptions
      for (const [market, subs] of this._marketSubs) {
        subs.delete(id);
      }
      console.log(`[SM] CLOSE ${id}, live=${this._liveSessions.size}`);
    }
  }

  private _seenClose(ws: WS, uuid: string): boolean {
    // Dedup close requests
    const id = (ws as any).id;
    if (!id || !uuid) return false;
    
    let socketCloses = this._recentClose.get(id);
    if (!socketCloses) {
      socketCloses = new Map();
      this._recentClose.set(id, socketCloses);
    }
    
    const now = Date.now();
    if (socketCloses.has(uuid) && now - socketCloses.get(uuid)! < 2000) {
      return true; // seen recently
    }
    
    socketCloses.set(uuid, now);
    return false;
  }

  private ensureSocketMarketIndex(socketId: string, marketKey: string): void {
    let subs = this._sessionSubs.get(socketId);
    if (!subs) {
      subs = new Set();
      this._sessionSubs.set(socketId, subs);
    }
    subs.add(marketKey);
  }

  private subscribeMarket(socketId: string, market: string, ws: WS, network?: string): void {
    const internalKey = this.makeInternalKey(market, network);
    
    let subs = this._marketSubs.get(internalKey);
    if (!subs) {
      subs = new Set();
      this._marketSubs.set(internalKey, subs);
    }
    subs.add(socketId);
    
    (ws as any)._markets?.add(internalKey);
    
    // Initialize market in engine if needed
    try {
      native.init_market?.(internalKey);
    } catch (e) {
      console.warn('[subscribeMarket] init error', e);
    }
    
    // Send initial snapshot
    this.sendOrderbookSnapshot(ws, market, this._depth, network);
  }

  private unsubscribeMarket(socketId: string, market: string, network?: string): void {
    const internalKey = this.makeInternalKey(market, network);
    this._marketSubs.get(internalKey)?.delete(socketId);
    
    const ws = this._liveSessions.get(socketId);
    if (ws) {
      (ws as any)._markets?.delete(internalKey);
    }
  }

  private broadcastToMarket(marketKey: string, payload: any): void {
    const subs = this._marketSubs.get(marketKey);
    if (!subs || subs.size === 0) return;
    
    const msg = JSON.stringify(payload);
    for (const socketId of subs) {
      const ws = this._liveSessions.get(socketId);
      if (ws) {
        try {
          ws.send(msg);
        } catch (e) {
          console.warn('[broadcast] send error', e);
        }
      }
    }
  }

  private sendOrderbookSnapshot(ws: WS, market: string, depth: number, network?: string): void {
    const internalKey = this.makeInternalKey(market, network);
    
    try {
      const snapRaw = (native as any).snapshot?.(internalKey);
      const snapObj = typeof snapRaw === 'string' ? JSON.parse(snapRaw) : snapRaw;
      
      if (snapObj) {
        ws.send(JSON.stringify({
          event: EmitEvents.ORDERBOOK_DATA,
          marketKey: market,
          orders: snapObj,
          isDelta: false,
        }));
      }
    } catch (e) {
      console.warn('[sendOrderbookSnapshot] error', e);
    }
  }

  private handleUpdateOrderbook(ws: WS, data: any): void {
    const market = this.resolveMarket(data);
    const network = data.network;
    if (market) {
      this.sendOrderbookSnapshot(ws, market, this._depth, network);
    }
  }

  private sweepOrders(socketId: string, reason: string): void {
    console.log(`[sweepOrders] ${socketId}: ${reason}`);
    // Cancel all orders for this socket across all markets
    const markets = this._sessionSubs.get(socketId);
    if (markets) {
      for (const market of markets) {
        try {
          (native as any).cancel_all_by_socket?.(market, socketId);
        } catch (e) {
          console.warn('[sweepOrders] error', e);
        }
      }
    }
  }

  private _handleExecs(symbol: string, execs: any[]): void {
    // Handle execution reports from the engine
    // Broadcast to relevant subscribers
    this.broadcastToMarket(symbol, {
      event: EmitEvents.TRADE_EXECUTED,
      marketKey: symbol,
      executions: execs,
    });
  }

  // --- REMAINING METHODS FROM ORIGINAL FILE ---
  // Copy the rest of your methods here (resolveMarket, deriveMarketFromOrder, etc.)
  // I've included the critical ones for the auth flow to work

  private deriveMarketFromOrder(data: any): string | null {
    // Implementation from your original file
    return null;
  }

  private resolveMarket(data: any): string {
    // Try close-order style fields first (they often differ from standard payloads)
    if (data.event === OnEvents.CLOSE_ORDER || data.event === 'close-order') {
      const explicit = data.marketKey ?? data.market ?? data.filter?.marketKey;
      if (explicit) return String(explicit);

      // FUTURES
      const cid = data.contract_id ?? data.contractId ??
        data.filter?.contract_id ?? data.filter?.contractId;
      const exp = data.expiry ?? data.maturity_block ??
        data.filter?.expiry ?? data.filter?.maturity_block;
      if (cid != null && this.futKey) {
        const fut = this.futKey(cid, exp);
        if (fut) return fut;
      }

      // SPOT
      const f =
        data.id_for_sale ?? data.filter?.id_for_sale ??
        data.order?.id_for_sale ?? data.payload?.id_for_sale;
      const d =
        data.id_desired ?? data.props?.id_desired ??
        data.order?.id_desired ?? data.payload?.id_desired;

      if (f != null && d != null && this.spotKeyFromIds) {
        const spot = this.spotKeyFromIds(f, d);
        if (spot) return spot;
      }
    }

      const direct =
          data?.marketKey ??
          data?.filter?.marketKey ??
          this.deriveMarketFromOrder?.(data);
        if (direct) return String(direct);

    // 3) Generic inference for non-close frames (or missed fields)
    const o = data?.order ?? data?.payload ?? data;

    // FUTURES from nested props
    const cid2 = o?.props?.contract_id ?? o?.props?.contractId ?? o?.contract_id ?? o?.contractId;
    const exp2 = o?.props?.expiry ?? o?.props?.maturity_block ?? o?.expiry ?? o?.maturity_block;
    if (cid2 != null && this.futKey) {
      const fut = this.futKey(cid2, exp2);
      if (fut) return fut;
    }

    // SPOT from nested ids
    const f2 = o?.props?.id_for_sale ?? o?.id_for_sale;
    const d2 = o?.props?.id_desired ?? o?.id_desired;
    if (f2 != null && d2 != null && this.spotKeyFromIds) {
      const spot = this.spotKeyFromIds(f2, d2);
      if (spot) return spot;
    }

    // 4) Symbol fallback (ensure -perp for futures-like symbols)
    const sym = data?.symbol ?? o?.symbol;
    if (sym) return this.ensurePerpSymbol(sym);

    return null;
  }

  /** Ensure a futures-like symbol is canonicalized (adds -perp when appropriate). */
  private ensurePerpSymbol(sym: any): string {
    const s = String(sym ?? '').trim();
    if (!s) return s;
    if (/-perp\b/i.test(s)) return s;
    // "3", "BTC-USD", or multi-dash codes are treated as futures-like and get -perp
    const isNumeric = /^\d+$/u.test(s);
    const multiDash = (s.match(/-/g) || []).length >= 1;
    return (isNumeric || multiDash) ? `${s}-perp` : s;
  }


  private normalizeOrder(raw: any, socketId: string): NormalizedOrder {
    const o: any = { ...(raw?.order ?? raw) };

    const uuid =
      o.uuid ||
      o.orderUUID ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const sideStr =
      (o.side || o.action || (o.props?.side as string) || 'BUY').toString();
    const side = sideStr.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    const price =
      Number(o.price ?? o.props?.price ?? o.rate ?? o.limit_price) || 0;
    const amount = Number(o.amount ?? o.props?.amount ?? o.quantity) || 0;

    if (!price || !amount) {
      return {
        uuid,
        socketId: socketId,
        price,
        amount,
        side: side as 'BUY' | 'SELL',
        error: 'Missing price/amount',
      };
    }

    return {
      uuid,
      socketId: socketId,
      price,
      amount,
      side: side as 'BUY' | 'SELL',
      type: o.type,
      action: o.action,
      props: o.props,
      keypair: o.keypair,
    };
  }

    private toJsOrder(o: {
      uuid: string;
      socketId: string;
      traderAddress?: string;
      side?: string;
      type?: 'SPOT' | 'FUTURES';
      action?: 'BUY' | 'SELL';
      props?: any;
      price: number;
      amount: number;
      quantity?: number;
      keypair?: any;
    }): JsOrder {
      const side = (o.side || o.action || 'BUY').toUpperCase();
      const payload = {
        uuid: o.uuid,
        socketId: o.socketId,          // camelCase for your code
        socket_id: o.socketId,         // <-- snake_case for native/Rust
        trader_address: o.traderAddress, // bound identity
        side: side === 'SELL' ? 'SELL' : 'BUY',
        price: Number(o.price),
        amount: Number(o.amount ?? o.quantity ?? 0),
        props: o.props,
        keypair: o.keypair,
        type: o.type,
        action: o.action,
      } as any;

      return payload as JsOrder;
    }

      // === Debug helpers used by routes ===
      public get liveSessions(): string[] {
        return Array.from(this._liveSessions.keys());
      }
      public get sessionCount(): number {
        return this._liveSessions.size;
      }

      
    private async newChannel(tradeInfo: ITradeInfo, unfilled: TOrder | null): Promise<IResultChannelSwap> {
      try {
        const buyerSocketId  = tradeInfo.buyer.socketId;
        const sellerSocketId = tradeInfo.seller.socketId;

        const buyerSocket  = this._liveSessions.get(buyerSocketId);
        const sellerSocket = this._liveSessions.get(sellerSocketId);

        if (!buyerSocket || !sellerSocket) {
          console.error('[Channel] missing socket(s)', { buyerSocketId, sellerSocketId });
          return { error: 'One of the sockets is not available' };
        }

        const channel = new ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
        const channelRes = await channel.onReady();
        if (channelRes.error || !channelRes.data) return channelRes;

        const historyTrade: IHistoryTrade = {
          txid: channelRes.data.txid,
          time: Date.now(),
          ...tradeInfo,
        };
        this.saveToHistory?.(historyTrade); // no-op if not present
        return channelRes;
      } catch (error: any) {
        return { error: error?.message ?? String(error) };
      }
    }

      
	  // Helper function for building trades
    private buildTrade(
      new_order: TOrder,
      old_order: TOrder
    ): IResult<{ unfilled: TOrder | null; tradeInfo: ITradeInfo }> {
      try {
        const ordersArray = [new_order, old_order];
        const buyOrder  = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);
        if (!buyOrder || !sellOrder) throw new Error('Building Trade Failed. Code 1');

        const newAmt = new_order.props.amount;
        const oldAmt = old_order.props.amount;
        const amount = Math.min(newAmt, oldAmt);
        const price  = old_order.props.price;
        const sellerIsMaker = old_order.action === EOrderAction.SELL;

        let tradeProps: any;
        let unfilled: TOrder | null = null;

        if (toEOrderType(buyOrder.type) === EOrderType.FUTURES) {
          // ---------- FUTURES branch ----------
          const pNew = new_order.props as IFuturesOrderProps;
          const pOld = old_order.props as IFuturesOrderProps;

          unfilled =
            newAmt > oldAmt
              ? ({ ...new_order, props: { ...pNew, amount: safeNumber(newAmt - oldAmt) } } as TOrder)
              : newAmt < oldAmt
              ? ({ ...old_order, props: { ...pOld, amount: safeNumber(oldAmt - newAmt) } } as TOrder)
              : null;

          tradeProps = {
            amount,
            contract_id: pNew.contract_id ?? pOld.contract_id,
            price,
            initMargin: pNew.initMargin ?? pOld.initMargin,
            collateral: pNew.collateral ?? pOld.collateral,
            sellerIsMaker,
          };
        } else {
          // ---------- SPOT branch ----------
          const pNew = new_order.props as ISpotOrderProps;
          const pOld = old_order.props as ISpotOrderProps;

          unfilled =
            newAmt > oldAmt
              ? ({ ...new_order, props: { ...pNew, amount: safeNumber(newAmt - oldAmt) } } as TOrder)
              : newAmt < oldAmt
              ? ({ ...old_order, props: { ...pOld, amount: safeNumber(oldAmt - newAmt) } } as TOrder)
              : null;

          tradeProps = {
            propIdDesired: pNew.id_desired ?? pOld.id_desired,
            propIdForSale: pNew.id_for_sale ?? pOld.id_for_sale,
            amountDesired: amount,
            amountForSale: safeNumber(amount * price),
            sellerIsMaker,
          };
        }

        const tradeInfo: ITradeInfo = {
          type: toEOrderType(new_order.type), // enum, not string
          buyer:  { socketId: buyOrder.socket_id,  keypair: buyOrder.keypair,  uuid: buyOrder.uuid },
          seller: { socketId: sellOrder.socket_id, keypair: sellOrder.keypair, uuid: sellOrder.uuid },
          taker: new_order.socket_id,
          maker: old_order.socket_id,
          props: tradeProps,
        };

        return { data: { unfilled, tradeInfo } };
      } catch (e: any) {
        return { error: e?.message ?? String(e) };
      }
    }

}

// singleton export
export const socketManager = new SocketManager();
