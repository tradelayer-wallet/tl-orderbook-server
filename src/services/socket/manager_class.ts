// ---------- imports ----------
import HyperExpress from 'hyper-express';
import { EmitEvents, OnEvents, OrderEmitEvents } from './events';
import { native, registerNativeSinks, JsOrder, Exec } from '../../native';
import { ChannelSwap } from "../channel-swap/channel-swap.class";
import { getSessionForToken } from '../../routes/auth.route';
import { canonicalAddress } from '../../crypto/bip322';
import { createHash, timingSafeEqual } from 'crypto';

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
 * - 'web': every client by default; MUST authenticate (BIP-322 session token) before mutations, and may only
 *   trade for the addresses it has authenticated
 * - 'bot': server-side trust via an API key whose sha256 is listed in TL_OB_BOT_KEYS; exempt from session auth
 * The class is never taken from a client-chosen header: only a matching key makes a socket a bot.
 */
type ClientClass = 'web' | 'bot';

// Extend WS type to include auth metadata
interface AuthenticatedWS extends HyperExpress.Websocket {
  id: string;
  _markets: Set<string>;
  clientClass: ClientClass;
  authed: boolean;
  /** address -> session token that authenticated it on this socket (expiry/revocation read from the session store) */
  authedAddresses: Map<string, string>;
  /** owner keys ("internalKey\0uuid") of orders this socket placed and may still have resting */
  _ownedKeys: Set<string>;
  _reconcileAt: number;
}

// Bot API keys: TL_OB_BOT_KEYS = comma separated sha256 hex digests of the keys. Parsed once at load.
const BOT_KEY_HASHES: Buffer[] = (process.env.TL_OB_BOT_KEYS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .flatMap((h) => {
    if (/^[0-9a-f]{64}$/.test(h)) return [Buffer.from(h, 'hex')];
    console.warn('[Auth] ignoring TL_OB_BOT_KEYS entry that is not a 64 hex char sha256');
    return [];
  });

/** Constant time: hashes the presented key and compares against every configured digest. */
export function isBotKey(presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  const digest = createHash('sha256').update(presented).digest();
  let ok = 0;
  for (const h of BOT_KEY_HASHES) ok |= timingSafeEqual(digest, h) ? 1 : 0;
  return ok === 1;
}

// A socket's owner records are reconciled against the engine's open orders once it holds this many.
const OWNED_RECONCILE_MIN = 512;
// Addresses one connection may authenticate.
const MAX_ADDRESSES_PER_SOCKET = 32;

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
  traderAddress?: string;  // NEW: bound identity from session
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

// Number of most recent history events sent in `placed-orders.orderHistory` after a new order / cancel.
const PLACED_ORDERS_HISTORY_LIMIT = 20;
// Depth of the L2 book sent in orderbook-data broadcasts.
const BOOK_BROADCAST_DEPTH = 50;
// Per-market snapshot coalescing window: a burst of orders produces one orderbook-data per window.
const COALESCE_MS = Number(process.env.OB_COALESCE_MS) > 0 ? Number(process.env.OB_COALESCE_MS) : 50;
// Per-message payload logging is off by default (set OB_DEBUG_LOG=1 to enable). Errors and warnings always log.
const DEBUG_LOG = process.env.OB_DEBUG_LOG === '1';

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
  // internalKey -> the client-facing market key (what clients put in orderbook:join / order frames, without the
  // network suffix). orderbook-data must carry exactly this string as `marketKey`; the FE drops frames whose
  // marketKey differs from the key it joined with. One internal market has one client-facing key (the internal
  // key is joinKey + network suffix), so a single topic publish per market serves every subscriber.
  private _baseKey = new Map<string, string>();
  // close-order snapshots owed to the closing socket: internalKey -> (socketId -> base marketKey)
  private _closePending = new Map<string, Map<string, string>>();
  private _coalesceMs = COALESCE_MS;
  private _servers: HyperExpress.Server[] = [];

  private _recentClose = new Map<string, Map<string, number>>();
  private _uuidToMarket = new Map<string, string>();
  private _byUuid = new Map<string, { market: string; price?: number; quantity?: number }>();

  private _tickHandle: NodeJS.Timeout | null = null;

  constructor() {
    // periodic broadcaster
    this._tickHandle = setInterval(() => this.flushOrderbookData(), this._coalesceMs);

    // wire sinks (native preferred, shim fallback)
    wireExecSinksStrict(native as any, registerNativeSinks, {
      onExecs: (symbol, execs) => this._handleExecs(symbol, execs),
      onSnapshot: (symbol) => {
        this._dirty.add(symbol);
      }
    });
  }

  /** Register a HyperExpress server so market fan-out can use uWS topic publish (one native send per subscriber). */
  attachServer(srv: HyperExpress.Server) {
    if (!this._servers.includes(srv)) this._servers.push(srv);
  }

  private static topicOf(internalKey: string) {
    return 'mkt:' + internalKey;
  }

  /** Client-facing market key for an internal key (recorded at join/order time; suffix-strip fallback). */
  private baseKeyOf(internalKey: string): string {
    let b = this._baseKey.get(internalKey);
    if (b === undefined) {
      b = this.parseInternalKey(internalKey).market;
      this._baseKey.set(internalKey, b);
    }
    return b;
  }

  /** Deliver one pre-serialized message to every subscriber of a market. */
  private publishToMarket(internalKey: string, str: string) {
    if (this._servers.length) {
      const topic = SocketManager.topicOf(internalKey);
      for (const srv of this._servers) srv.publish(topic, str);
      return;
    }
    const ids = this._marketSubs.get(internalKey);
    if (!ids) return;
    for (const id of ids) {
      const ws = this._liveSessions.get(id);
      if (!ws) continue;
      try {
        if ((ws as any).bufferedAmount && (ws as any).bufferedAmount > 1_000_000) continue;
        ws.send(str);
      } catch {}
    }
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

  /** Coalesced snapshot broadcast: one engine snapshot + one serialization + one publish per dirty market per tick. */
  private flushOrderbookData() {
    if (this._closePending.size) this.flushCloseSnapshots();
    if (this._dirty.size === 0) return;
    const markets = Array.from(this._dirty);
    this._dirty.clear();
    for (const mk of markets) {
      const subs = this._marketSubs.get(mk);
      if (!subs || subs.size === 0) continue;
      try {
        const l2 = native.snapshotL2(mk, BOOK_BROADCAST_DEPTH, false);
        this.publishToMarket(
          mk,
          `{"event":"${EmitEvents.ORDERBOOK_DATA}","marketKey":${JSON.stringify(this.baseKeyOf(mk))},"orders":${l2},"isDelta":false,"history":0}`
        );
      } catch (e) {
        console.warn('[flush snapshot err]', mk, e);
      }
    }
  }

  /** One snapshot per market per tick, sent to every socket that cancelled an order on it since the last tick. */
  private flushCloseSnapshots() {
    const pending = this._closePending;
    this._closePending = new Map();
    for (const [internalKey, socks] of pending) {
      let orders: string | null = null;
      for (const [sid, marketKey] of socks) {
        const ws = this._liveSessions.get(sid);
        if (!ws) continue;
        try {
          if (orders === null) orders = this.directBookJson(internalKey, marketKey, 50);
          ws.send(
            `{"event":"${EmitEvents.ORDERBOOK_DATA}","marketKey":${JSON.stringify(marketKey)},"orders":${orders},"isDelta":false,"openedOrders":[],"history":[]}`
          );
        } catch (e) {
          console.warn('[close-order] snapshot send error', e);
        }
      }
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
  // Auth: client classification, address binding, order ownership
  // -----------------------------------------------------------------------------

  /** Orders placed through this server: "internalKey\0uuid" -> owner. Entries die with the order's socket or its close. */
  private _orderOwners = new Map<string, { address: string; sid: string }>();

  private static ownerKey(internalKey: string, uuid: string): string {
    return internalKey + '\u0000' + uuid;
  }

  /**
   * Classify a new socket from its upgrade request ({ headers, query }). Only an API key whose sha256 is listed
   * in TL_OB_BOT_KEYS makes a bot. A presented key that does not match is rejected; no key means 'web'.
   */
  private detectClientClass(req?: any): { clientClass: ClientClass; keyRejected: boolean } {
    const raw = req?.headers?.['x-tl-api-key'] ?? req?.query?.apiKey ?? req?.query?.api_key;
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (presented === undefined || presented === null || presented === '') {
      return { clientClass: 'web', keyRejected: false };
    }
    if (isBotKey(presented)) return { clientClass: 'bot', keyRejected: false };
    return { clientClass: 'web', keyRejected: true };
  }

  /**
   * The address a socket may act as: `raw` is canonicalised and must have been authenticated on this socket
   * with a session that is still valid (unexpired, not revoked). A dead session drops its address.
   */
  private authorizedAddress(authWs: AuthenticatedWS, raw: unknown): string | null {
    const address = canonicalAddress(String(raw ?? ''));
    if (!address) return null;
    const token = authWs.authedAddresses.get(address);
    if (!token) return null;
    const s = getSessionForToken(token);
    if (!s || canonicalAddress(s.address) !== address) {
      authWs.authedAddresses.delete(address);
      authWs.authed = authWs.authedAddresses.size > 0;
      return null;
    }
    return address;
  }

  /** Drop every address whose session has expired or been revoked. */
  private pruneAuthedAddresses(authWs: AuthenticatedWS) {
    for (const address of Array.from(authWs.authedAddresses.keys())) this.authorizedAddress(authWs, address);
  }

  /**
   * Address an order is placed for. Web sockets: the order's keypair.address, which must be authenticated on this
   * socket. Bots: keypair.address when present, no session check.
   */
  private orderAddress(authWs: AuthenticatedWS, order: { keypair?: any }): { address?: string; error?: string } {
    const claimed = order?.keypair?.address;
    if (authWs.clientClass === 'bot') {
      return { address: claimed ? canonicalAddress(String(claimed)) : '' };
    }
    if (!claimed) return { error: 'keypair.address is required' };
    const address = this.authorizedAddress(authWs, claimed);
    if (!address) {
      return { error: `Address ${String(claimed).slice(0, 100)} is not authenticated on this connection. Send { event: "auth", token }.` };
    }
    return { address };
  }

  /** Error text when `uuid` is already owned by another address in this market, else null. */
  private orderUuidConflict(internalKey: string, uuid: string, address: string): string | null {
    const prev = this._orderOwners.get(SocketManager.ownerKey(internalKey, uuid));
    return prev && prev.address !== address ? 'Order uuid is already in use' : null;
  }

  private claimOrder(authWs: AuthenticatedWS, internalKey: string, uuid: string, address: string) {
    const key = SocketManager.ownerKey(internalKey, uuid);
    this._orderOwners.set(key, { address, sid: authWs.id });
    authWs._ownedKeys.add(key);
  }

  private releaseOrder(authWs: AuthenticatedWS, key: string) {
    authWs._ownedKeys.delete(key);
    if (this._orderOwners.get(key)?.sid === authWs.id) this._orderOwners.delete(key);
  }

  /** The order is gone (cancelled): drop its owner record wherever it is held. */
  private forgetOrder(key: string) {
    const own = this._orderOwners.get(key);
    if (!own) return;
    this._orderOwners.delete(key);
    (this._liveSessions.get(own.sid) as AuthenticatedWS | undefined)?._ownedKeys.delete(key);
  }

  /** Close/amend: the stored order's owner must be an address authenticated on this socket (bots are exempt). */
  private orderOwnerError(authWs: AuthenticatedWS, internalKey: string, uuid: string): string | null {
    if (authWs.clientClass === 'bot') return null;
    const own = this._orderOwners.get(SocketManager.ownerKey(internalKey, uuid));
    if (!own) return 'Unknown order';
    if (!this.authorizedAddress(authWs, own.address)) {
      return 'Order belongs to an address that is not authenticated on this connection';
    }
    return null;
  }

  /**
   * Bound the owner records: once a socket holds many, drop those whose order no longer rests in the engine
   * (filled or cancelled). The engine's per-socket open list is the source of truth.
   */
  private reconcileOwned(authWs: AuthenticatedWS) {
    if (authWs._ownedKeys.size < authWs._reconcileAt) return;
    const byMarket = new Map<string, string[]>();
    for (const key of authWs._ownedKeys) {
      const i = key.indexOf('\u0000');
      const m = key.slice(0, i);
      let l = byMarket.get(m);
      if (!l) byMarket.set(m, (l = []));
      l.push(key.slice(i + 1));
    }
    for (const [market, uuids] of byMarket) {
      let open: Set<string>;
      try {
        const rows = JSON.parse(native.get_open_orders_by_socket(authWs.id, market));
        open = new Set<string>(Array.isArray(rows) ? rows.map((r: any) => String(r.uuid)) : []);
      } catch {
        continue;
      }
      for (const u of uuids) {
        if (!open.has(u)) this.releaseOrder(authWs, SocketManager.ownerKey(market, u));
      }
    }
    authWs._reconcileAt = Math.max(OWNED_RECONCILE_MIN, authWs._ownedKeys.size * 2);
  }

  // === Public API expected by index.ts ===
  /** `req` is the upgrade context from index.ts: { headers, query }. */
  handleOpen = (ws: WS, req?: any) => {
    const authWs = ws as AuthenticatedWS;

    const { clientClass, keyRejected } = this.detectClientClass(req);
    if (keyRejected) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Invalid API key' }));
      ws.close(4401, 'invalid api key');
      return;
    }

    const id = this.generateUniqueId();
    authWs.id = id;
    authWs._markets = new Set<string>();
    authWs.clientClass = clientClass;
    authWs.authed = clientClass === 'bot';
    authWs.authedAddresses = new Map();
    authWs._ownedKeys = new Set();
    authWs._reconcileAt = OWNED_RECONCILE_MIN;

    this._liveSessions.set(id, ws);

    ws.on('message', (m) => {
      this.handleMessage(ws, m).catch((e) => console.error('[SM] message handler failed', e));
    });
    ws.on('close', () => this.handleClose(ws));

    ws.send(JSON.stringify({
      event: 'connected',
      id,
      clientClass,
      authRequired: clientClass === 'web',
    }));

    if (DEBUG_LOG) console.log(`[SM] OPEN ${id}, clientClass=${clientClass}, live=${this._liveSessions.size}`);
  };

  // === Event handlers ===
  private async handleMessage(ws: WS, message: ArrayBuffer | string) {
    const authWs = ws as AuthenticatedWS;  // NEW: cast for auth access
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
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
    if (DEBUG_LOG) console.log('incoming message '+JSON.stringify(data))

    // -------------------------------------------------------------------------
    // AUTH HANDSHAKE: { event: 'auth', token }. Each valid token adds its session's address to the
    // addresses this socket may trade for; a fresh token for a known address extends it.
    // -------------------------------------------------------------------------
    if (data.event === 'auth') {
      if (authWs.clientClass !== 'web') {
        ws.send(JSON.stringify({ 
          event: 'auth_ignored', 
          message: `Auth not required for ${authWs.clientClass} clients` 
        }));
        return;
      }

      const token = typeof data.token === 'string' ? data.token : '';
      if (!token) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Missing token' }));
        return;
      }

      const session = getSessionForToken(token);
      if (!session) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Invalid or expired session' }));
        return;
      }

      const address = canonicalAddress(session.address);
      const heldToken = authWs.authedAddresses.get(address);
      const held = heldToken ? getSessionForToken(heldToken) : null;
      if (!held && authWs.authedAddresses.size >= MAX_ADDRESSES_PER_SOCKET) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: 'Too many addresses on one connection' }));
        return;
      }
      // keep whichever session for this address lasts longer
      let expiresAt = session.expiresAt;
      if (held && held.expiresAt > session.expiresAt) {
        expiresAt = held.expiresAt;
      } else {
        authWs.authedAddresses.set(address, token);
      }
      authWs.authed = true;

      ws.send(JSON.stringify({ event: 'auth_ok', address, expiresAt }));

      if (DEBUG_LOG) console.log(`[Auth] Web client ${authWs.id} authenticated as ${address}`);
      return;
    }

    // -------------------------------------------------------------------------
    // GATE MUTATIONS (web clients): at least one live authenticated address. Per-order address binding
    // and ownership are enforced in the handlers.
    // -------------------------------------------------------------------------
    if (MUTATING_EVENTS.has(data.event) && authWs.clientClass === 'web') {
      this.pruneAuthedAddresses(authWs);
      if (!authWs.authed) {
        ws.send(JSON.stringify({ 
          event: OrderEmitEvents.ERROR, 
          message: 'Authentication required (web client). Send { event: "auth", token } first.' 
        }));
        return;
      }
    }

    // -------------------------------------------------------------------------
    // EXISTING: Event routing (unchanged)
    // -------------------------------------------------------------------------
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

      const denied = this.orderOwnerError(authWs, internalKey, uuid);
      if (denied) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: denied }));
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
        if (DEBUG_LOG) console.log(`[SM] Unknown event type: ${data.event}`);
      }
    }
  }

  private async handleNewOrder(ws: HyperExpress.Websocket, data: any){
    const authWs = ws as AuthenticatedWS;  // NEW: cast for auth access
    
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
    this.ensureSocketMarketIndex(sid, internalKey, market || undefined);
    
    if (!market) {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: 'Missing marketKey'
      }));
      return;
    }

    // ⚙️ 3. Normalize & ACK
    const order = this.normalizeOrder(data, sid) as NormalizedOrder;
    if (order.error) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: order.error }));
      return;
    }

    // -------------------------------------------------------------------------
    // Address binding: the order's keypair.address must be authenticated on this socket (bots exempt),
    // and the order uuid must not belong to another address.
    // -------------------------------------------------------------------------
    const who = this.orderAddress(authWs, order);
    const denied = who.error ?? this.orderUuidConflict(internalKey, order.uuid, who.address ?? '');
    if (denied) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: denied }));
      return;
    }
    order.traderAddress = who.address || undefined;
    if (authWs.clientClass === 'web' && order.props) {
      // Override any client-supplied address for web clients
      order.props.trader = who.address;
      order.props.address = who.address;
    }
    this.claimOrder(authWs, internalKey, order.uuid, who.address ?? '');

    try {
      ws.send(JSON.stringify({
        event: OrderEmitEvents.SAVED,
        orderUuid: order.uuid
      }));

      // 4. Submit to native engine with internal key
      native.submit(internalKey, this.toJsOrder(order));
      this.reconcileOwned(authWs);

      // 5. Immediate placed-orders tray: built by the addon as the final wire message
      //    (open orders + the most recent PLACED_ORDERS_HISTORY_LIMIT history events).
      try {
        ws.send(native.getPlacedOrdersJson(sid, internalKey, PLACED_ORDERS_HISTORY_LIMIT));
      } catch (err) {
        console.warn('[placed-orders err]', err);
      }

      // 6. Market snapshot: mark the market dirty. The submitter is already indexed as a subscriber
      //    (ensureSocketMarketIndex above), so the next coalescer tick delivers one orderbook-data to
      //    every subscriber, the submitter included.
      this._dirty.add(internalKey);
    } catch (e: any) {
      this.releaseOrder(authWs, SocketManager.ownerKey(internalKey, order.uuid));
      ws.send(JSON.stringify({
        event: OrderEmitEvents.ERROR,
        message: e?.message || 'submit failed'
      }));
    }
  }

  private async handleManyOrders(ws: WS, data: any) {
    const authWs = ws as AuthenticatedWS;  // NEW: cast for auth access
    const sid = (ws as any).id as string;
    const network = data.network;
    const market = this.resolveMarket(data);
    const internalKey = this.makeInternalKey(market, network);
    this.ensureSocketMarketIndex(sid, internalKey, market || undefined);
    
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
    // Validate the whole batch before anything is acknowledged, claimed or submitted.
    const normalized: NormalizedOrder[] = [];
    const addresses: string[] = [];
    for (const o of rawOrders) {
      const norm = this.normalizeOrder(o, sid) as NormalizedOrder;
      const who = this.orderAddress(authWs, norm);
      const denied = norm.error ?? who.error ?? this.orderUuidConflict(internalKey, norm.uuid, who.address ?? '');
      if (denied) {
        ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: denied }));
        return;
      }
      norm.traderAddress = who.address || undefined;
      if (authWs.clientClass === 'web' && norm.props) {
        norm.props.trader = who.address;
        norm.props.address = who.address;
      }
      normalized.push(norm);
      addresses.push(who.address ?? '');
    }
    normalized.forEach((norm, i) => this.claimOrder(authWs, internalKey, norm.uuid, addresses[i]));

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
      this.reconcileOwned(authWs);

      this.broadcastToMarket(internalKey, {
        event: EmitEvents.UPDATE_ORDERS_REQUEST,
        marketKey: market,
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
    if (DEBUG_LOG) console.log('uuid', uuid, internalKey);

    if (!market) {
      console.warn('[close-order] missing marketKey for uuid', uuid);
      return;
    }

    // only the owner (an address authenticated on this socket) may cancel; bots are exempt
    const authWs = ws as AuthenticatedWS;
    const denied = this.orderOwnerError(authWs, internalKey, uuid);
    if (denied) {
      ws.send(JSON.stringify({ event: OrderEmitEvents.ERROR, message: denied }));
      return;
    }
    this.ensureSocketMarketIndex(sid, internalKey, market || undefined);

    try {
      // cancel on the engine
      if ((native as any).cancel?.(internalKey, uuid)) {
        this.forgetOrder(SocketManager.ownerKey(internalKey, uuid));
      }
    } catch (e) {
      console.warn('[close-order] cancel error', e);
    }

    // fresh opened orders + recent history for THIS socket & market
    try {
      ws.send(native.getPlacedOrdersJson(sid, internalKey, PLACED_ORDERS_HISTORY_LIMIT));
    } catch (err) {
      console.warn('[close-order] post-cancel fetch/send err', err);
      ws.send(JSON.stringify({
        event: EmitEvents.PLACED_ORDERS,
        openedOrders: [],
        orderHistory: [],
      }));
    }

    // every other subscriber learns of the cancel from the next coalesced orderbook-data (the engine's snapshot
    // sink does not fire for cancels)
    this._dirty.add(internalKey);

    // then the fresh book for this socket, from the next coalescer tick (one snapshot per market per tick)
    let owed = this._closePending.get(internalKey);
    if (!owed) this._closePending.set(internalKey, (owed = new Map()));
    owed.set(sid, market);
  }

  // === Update snapshot request ===
  private handleUpdateOrderbook(ws: WS, data: any) {
    // Accept: {marketKey}, {symbol}, {filter:{...}}, or flat fields
    const payload = (data && typeof data === 'object') ? data : {};
    const filter  = (payload.filter && typeof payload.filter === 'object') ? payload.filter : payload;
    const network = data.network || filter.network;

    // Prefer explicit on-wire key first
    let mk: string | undefined =
      (typeof payload.marketKey === 'string' && payload.marketKey) ||
      (typeof payload.symbol === 'string' && payload.symbol)     ||
      undefined;

    // Try to derive when not provided
    if (!mk) {
      const type = String(filter.type || payload.type || '').toUpperCase();

      if (type === 'SPOT') {
        // tolerate several field names
        const a = Number(filter.first_token ?? filter.base ?? filter.id_for_sale ?? filter.pair?.[0]);
        const b = Number(filter.second_token ?? filter.quote ?? filter.id_desired ?? filter.pair?.[1]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          const base  = Math.min(a, b);
          const quote = Math.max(a, b);
          mk = `${base}-${quote}`;
        }
      } else if (type === 'FUTURES') {
        const cid = Number(filter.contract_id ?? filter.id ?? payload.contract_id ?? payload.id);
        if (Number.isFinite(cid)) {
          mk = `${cid}-perp`;
        }
      }

      // Last chance: if a legacy marketKey/symbol is lurking inside filter
      if (!mk && typeof filter.marketKey === 'string') mk = filter.marketKey;
      if (!mk && typeof filter.symbol    === 'string') mk = filter.symbol;
    }

    // Depth handling (accept string/number anywhere)
    const rawDepth = filter.depth ?? payload.depth;
    const depth = Number.isFinite(Number(rawDepth)) ? Number(rawDepth) : 50;
    if (DEBUG_LOG) console.log('inside handle orderbook update '+mk)
    if (!mk) {
      // No way to resolve — reply with an empty snapshot object (FE renders this shape)
      ws.send(JSON.stringify({
        event: EmitEvents.ORDERBOOK_DATA,
        marketKey: '',
        orders: { symbol: '', timestamp: Date.now(), bids: [], asks: [], checksum: '' },
        isDelta: false,
        openedOrders: [],
        history: [],
      }));
      return;
    }

    // Emit a fresh snapshot right away
    this.sendOrderbookSnapshot(ws, mk, depth, network);
  }

  // === Native exec fanout ===
  private async _handleExecs(
    marketKey: string,
    execs: Array<{
      price: number;
      quantity: number;
      maker_socketId?: string; maker_socket_id?: string;
      taker_socketId?: string; taker_socket_id?: string;
      maker_ext_uuid?: string;
      taker_ext_uuid?: string;
      side_of_taker?: 'BUY' | 'SELL'; sideOfTaker?: 'BUY' | 'SELL';
      props?: any;
      taker_keypair?: { address: string; pubkey: string };
      maker_keypair?: { address: string; pubkey: string };
    }>
  ) {
    // marketKey here is the internal key (e.g., "5-4-LTCTEST")
    // Parse it to get base market for client display
    const { market: baseMarket } = this.parseInternalKey(marketKey);
    
    // Normalize first so logs/use are consistent
    const normalized = (Array.isArray(execs) ? execs : []).map((raw: any) => {
      const makerSocketId = raw.maker_socketId ?? raw.maker_socket_id ?? null;
      const takerSocketId = raw.taker_socketId ?? raw.taker_socket_id ?? null;
      const makerUuid     = raw.maker_ext_uuid ?? '';
      const takerUuid     = raw.taker_ext_uuid ?? '';
      const sideOfTaker   = (raw.side_of_taker ?? raw.sideOfTaker ?? 'BUY') as 'BUY' | 'SELL';
      const price         = Number(raw.price) || 0;          // MATCH price
      const quantity      = Number(raw.quantity) || 0;
      const props         = raw.props ?? null;
      const takerKeypair  = raw.taker_keypair ?? raw.takerKeypair ?? null;
      const makerKeypair  = raw.maker_keypair ?? raw.makerKeypair ?? null;

      // Derive buyer/seller socket ids
      const buyerSocketId  = sideOfTaker === 'BUY' ? takerSocketId : makerSocketId;
      const sellerSocketId = sideOfTaker === 'BUY' ? makerSocketId : takerSocketId;

      // Derive: seller is maker iff taker buys
      const sellerIsMaker = sideOfTaker === 'BUY';

      // FUTURES detection (server-side convention)
      const isFutures =
        props && typeof props === 'object' &&
        (props.contract_id != null || props.contractId != null);

      // Enrich props idempotently
      let nextProps: any;
      if (props && typeof props === 'object') {
        nextProps = Object.prototype.hasOwnProperty.call(props, 'sellerIsMaker')
          ? props
          : { ...props, sellerIsMaker };
      } else {
        nextProps = { sellerIsMaker };
      }

      // Only for FUTURES, attach canonical prices (don't overwrite if already present)
      if (isFutures) {
        const orderPriceNum = Number(nextProps?.price);
        const orderPrice = Number.isFinite(orderPriceNum) ? orderPriceNum : null;
        if (!Object.prototype.hasOwnProperty.call(nextProps, 'execPrice'))  nextProps.execPrice  = price;
        if (!Object.prototype.hasOwnProperty.call(nextProps, 'orderPrice')) nextProps.orderPrice = orderPrice;
      }
      
      return {
        price,
        quantity,
        makerSocketId,
        takerSocketId,
        makerUuid,
        takerUuid,
        sideOfTaker,
        props: nextProps,
        takerKeypair,
        makerKeypair,                 // <— normalized here
        buyerSocketId,
        sellerSocketId,
        type: isFutures ? EOrderType.FUTURES : EOrderType.SPOT as const,
      };
    });

    if (DEBUG_LOG) console.log('[EXEC/IN]', marketKey, normalized.length, normalized[0]);

    // Process each exec slice
    for (const ex of normalized) {
      try {
        const {
          price, quantity,
          makerSocketId, takerSocketId,
          makerUuid, takerUuid,
          sideOfTaker, props, takerKeypair, makerKeypair,
          buyerSocketId, sellerSocketId,
          type,
        } = ex;

        if (!buyerSocketId || !sellerSocketId) {
          console.warn('[EXEC] missing socket ids', { raw: ex, buyerSocketId, sellerSocketId });
          continue;
        }

        // Role-aware identities
        const buyerIsTaker = (sideOfTaker === 'BUY'); // if taker buys, taker is buyer
        const buyerKey  = buyerIsTaker ? (takerKeypair ?? { address: undefined, pubkey: undefined })
                                      : (makerKeypair ?? { address: undefined, pubkey: undefined });
        const sellerKey = buyerIsTaker ? (makerKeypair ?? { address: undefined, pubkey: undefined })
                                      : (takerKeypair ?? { address: undefined, pubkey: undefined });

        let tradeProps: any;

        if (type === EOrderType.FUTURES) {
          // Ensure we carry contract id in a canonical field
          const cidRaw = props?.contract_id ?? props?.contractId;
          const contractId = Number(cidRaw);
          if (!Number.isFinite(contractId)) {
            console.warn('[EXEC] FUTURES missing/invalid contract_id', { marketKey, props });
            continue; // skip malformed
          }
          tradeProps = {
            ...props,
            // canonical futures fields expected by channel/wallet
            contract_id: contractId,
            amount: quantity,
            price: props?.execPrice ?? price, // exec (match) price drives PnL/fees
            // initMargin / collateral / transfer are preserved if present in props
          };
        } else {
          // SPOT shape: keep compatibility with existing wallet expectations
          const idDesired = props?.id_desired ?? props?.idDesired;
          const idForSale = props?.id_for_sale ?? props?.idForSale;

          tradeProps = {
            ...props,
            propIdDesired: idDesired,
            propIdForSale: idForSale,
            amountDesired: safeNumber(quantity * price),
            amountForSale: quantity,
            price,
          };
        }

        const tradeInfo: ITradeInfo = {
          type,
          buyer:  { socketId: buyerSocketId,  keypair: buyerKey,  uuid: takerUuid },
          seller: { socketId: sellerSocketId, keypair: sellerKey, uuid: makerUuid },
          taker: takerSocketId ?? '',
          maker: makerSocketId ?? '',
          props: tradeProps,
        };

        if (DEBUG_LOG) console.log('trade info '+JSON.stringify(tradeInfo))
        const res = this.newChannel(tradeInfo, null);
      } catch (e) {
        console.error('[EXEC] handler threw', e);
      }
    }

    // === Per-socket refresh (once per batch) ===
    const sockets = new Set<string>(
      (normalized ?? [])
        .flatMap(ex => [ex.makerSocketId, ex.takerSocketId])
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
    );

    let payload = '';
    try {
      payload = JSON.stringify({ event: EmitEvents.UPDATE_ORDERS_REQUEST, marketKey: baseMarket });
    } catch (e) {
      console.error('[EXEC] refresh: payload stringify failed', { marketKey, e });
      return;
    }

    for (const sid of sockets) {
      const ws = this._liveSessions.get(sid);
      if (!ws) {
        console.warn('[EXEC] refresh: missing live session', { sid, marketKey });
        continue;
      }

      // Best-effort OPEN check if the impl provides one
      const rstate = (ws as any)?.readyState;
      if (typeof rstate === 'number' && rstate !== 1 /* OPEN */) {
        console.warn('[EXEC] refresh: socket not OPEN', { sid, state: rstate, marketKey });
        continue;
      }

      try {
        ws.send(payload);
      } catch (e) {
        console.error('[EXEC] refresh send failed', { sid, marketKey, e });
      }
    }
  }

  // === Market subscription helpers ===
  private subscribeMarket(socketId: string, marketKey: string, ws: WS, network?: string) {
    // Use internal key for subscription tracking
    const internalKey = this.makeInternalKey(marketKey, network);
    this._baseKey.set(internalKey, marketKey);
    
    if (!this._marketSubs.has(internalKey))
      this._marketSubs.set(internalKey, new Set());
    this._marketSubs.get(internalKey)!.add(socketId);

    if (!this._sessionSubs.has(socketId))
      this._sessionSubs.set(socketId, new Set());
    this._sessionSubs.get(socketId)!.add(internalKey);

    (ws as any)._markets.add(internalKey);
    try { ws.subscribe(SocketManager.topicOf(internalKey)); } catch {}
    if (DEBUG_LOG) console.log('[sub] add', socketId, internalKey, 'size=', this._sessionSubs.get(socketId)?.size);

    // one-shot snapshot
    this.sendOrderbookSnapshot(ws, marketKey, 50, network);
  }

  private unsubscribeMarket(socketId: string, marketKey: string, network?: string) {
    const internalKey = this.makeInternalKey(marketKey, network);
    const ws = this._liveSessions.get(socketId);
    this._marketSubs.get(internalKey)?.delete(socketId);
    this._sessionSubs.get(socketId)?.delete(internalKey);
    (ws as any)?._markets?.delete(internalKey);
    try { ws?.unsubscribe(SocketManager.topicOf(internalKey)); } catch {}
    if (DEBUG_LOG) console.log('[sub] del', socketId, internalKey, 'size=', this._sessionSubs.get(socketId)?.size);
  }

  // ensure socket↔market is indexed even if client never "joined"
private ensureSocketMarketIndex(socketId: string, internalKey: string, baseKey?: string) {
  if (baseKey && !this._baseKey.has(internalKey)) this._baseKey.set(internalKey, baseKey);
  if (!this._sessionSubs.has(socketId)) this._sessionSubs.set(socketId, new Set());
  this._sessionSubs.get(socketId)!.add(internalKey);

  let subs = this._marketSubs.get(internalKey);
  if (!subs) this._marketSubs.set(internalKey, (subs = new Set()));

  const ws = this._liveSessions.get(socketId) as any;
  if (!subs.has(socketId)) {
    subs.add(socketId);
    try { ws?.subscribe?.(SocketManager.topicOf(internalKey)); } catch {}
  }
  if (ws?._markets instanceof Set) ws._markets.add(internalKey);
}


  public broadcastToMarket(marketKey: string, msg: object) {
    const ids = this._marketSubs.get(marketKey);
    if (!ids || ids.size === 0) return;
    this.publishToMarket(marketKey, JSON.stringify(msg));
  }

  public broadcastToAll(msg: object) {
    const str = JSON.stringify(msg);
    for (const ws of this._liveSessions.values()) {
      try {
        ws.send(str);
      } catch {}
    }
  }
// === Snapshots/opened tray ===
private static emptyBookJson(symbol: string) {
  return JSON.stringify({ symbol, timestamp: Date.now(), bids: [], asks: [], checksum: '' });
}

/** FE L2 object as JSON text (scaled, empty levels dropped) for join / update-orderbook / close-order replies. */
private directBookJson(internalKey: string, marketKey: string, depth: number): string {
  try {
    // The addon builds the object (scaled prices/amounts, empty levels dropped) and returns it as JSON text.
    const l2 = native.snapshotL2(internalKey, depth, true);
    return l2 === 'null' ? SocketManager.emptyBookJson(marketKey) : l2;
  } catch {
    return SocketManager.emptyBookJson(marketKey);
  }
}

private sendOrderbookSnapshot(ws: WS, marketKey: string, depth = 50, network?: string) {
  if (!marketKey) {
    ws.send(
      `{"event":"${EmitEvents.ORDERBOOK_DATA}","marketKey":"","orders":${SocketManager.emptyBookJson('')},"isDelta":false,"openedOrders":[],"history":[]}`
    );
    return;
  }

  const internalKey = this.makeInternalKey(marketKey, network);
  const orders = this.directBookJson(internalKey, marketKey, depth);
  ws.send(
    `{"event":"${EmitEvents.ORDERBOOK_DATA}","marketKey":${JSON.stringify(marketKey)},"orders":${orders},"isDelta":false,"openedOrders":[],"history":[]}`
  );
}

  // === WS lifecycle ===
  private handleClose(ws: WS) {
    const id = (ws as any).id as string;

    // Capture markets BEFORE mutating indices
    const joined = new Set(this._sessionSubs.get(id) ?? []);

    // Do the sweep first so listJoinedMarkets (or the captured set) has data
    this.sweepOrders(id, 'tcp-close', joined);

    // Now clean indices
    if (joined.size) {
      for (const mk of joined) this._marketSubs.get(mk)?.delete(id);
    }
    this._sessionSubs.delete(id);
    this._liveSessions.delete(id);
    this._recentClose.delete(id);
    for (const owed of this._closePending.values()) owed.delete(id);

    if (DEBUG_LOG) console.log(`[SM] Connection closed: ${id}`);
  }

  private _seenClose(ws: WS, uuid: string, ms = 1500) {
    const sid = (ws as any).id as string;
    if (!uuid) return false; // don't block if input is bad

    let byUuid = this._recentClose.get(sid);
    if (!byUuid) this._recentClose.set(sid, (byUuid = new Map<string, number>()));

    const now  = Date.now();
    const prev = byUuid.get(uuid);   // ← undefined on first sighting
    byUuid.set(uuid, now);
    if (byUuid.size > 512) {
      for (const [u, t] of byUuid) if (now - t >= ms) byUuid.delete(u);
    }
    // only treat as dup if we actually saw it before
    return prev != null && (now - prev) < ms;
  }

  /** Return all market keys this socket is currently subscribed to */
  public listJoinedMarkets(socketId: string): string[] {
    return Array.from(this._sessionSubs.get(socketId) ?? []);
  }

  private callPerMarket = (mk: string, id: string) => {
    const f = (native as any).cancel_all_by_socket;
    if (DEBUG_LOG) console.log('[typeof cancel_all_by_socket]', typeof f);
    if (typeof f !== 'function') {
      throw new Error('native.cancel_all_by_socket is missing on this object');
    }
    const r = f(mk, id);
    if (DEBUG_LOG) console.log('[sweep] cancel_all_by_socket(', mk, ',', id, ') ->', r);
    return r;
  };

 private sweepOrders(id: string, reason = 'tcp-close', markets?: Set<string> | string[]) {
    let list: string[] =
      (Array.isArray(markets) ? markets :
      markets instanceof Set ? Array.from(markets) :
      Array.from(this._sessionSubs.get(id) ?? []));

    if (list.length === 0) list = Array.from(this._marketSubs.keys());

    if (DEBUG_LOG) console.log('sweepOrders markets', list.length, list);

    const global = (native as any).cancel_all_by_socket_global;
  if (typeof global === 'function') {
    try {
      const r = global(id);
      if (DEBUG_LOG) console.log('[sweep] cancel_all_by_socket_global(', id, ') ->', r);
    } catch (e) {
      console.warn('[sweep] global cancel failed', e);
    }
    // 🔁 short delayed retry to catch races
    setTimeout(() => {
      try {
        const r2 = (native as any).cancel_all_by_socket_global?.(id);
        if (DEBUG_LOG) console.log('[sweep] delayed global retry(', id, ') ->', r2);
      } catch (e) {
        console.warn('[sweep] delayed global retry failed', e);
      }
    }, 200);
  } else {
    console.warn('[sweep] global cancel not available on native');
  }

    // fresh book for every affected market, delivered by the per-market coalescer
    for (const internalKey of list) this._dirty.add(internalKey);

    // the socket's orders are cancelled above: drop their owner records
    const closing = this._liveSessions.get(id) as AuthenticatedWS | undefined;
    if (closing?._ownedKeys) for (const key of Array.from(closing._ownedKeys)) this.releaseOrder(closing, key);

    this._liveSessions.delete(id);
    if (DEBUG_LOG) console.log(`${id} disconnected (${reason})`);
  }


  // === Utilities ===
  private generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private deriveMarketFromOrder(data: any): string | null {
      const o = data?.order ?? data;
      if (DEBUG_LOG) console.log('data in deriver market '+JSON.stringify(data))
      // explicit beats inference
      const mk =
        o?.marketKey ??
        o?.symbol ??
        o?.props?.marketKey ??
        o?.props?.symbol;
      if (mk) return String(mk);

      // SPOT inference by IDs → "min-max"
      const f = o?.props?.id_for_sale ?? o?.id_for_sale;
      const d = o?.props?.id_desired  ?? o?.id_desired;
      const spot = this.spotKeyFromIds(f, d);
      if (spot) return spot;

      // FUTURES inference
      const cid = o?.props?.contract_id ?? o?.props?.contractId;
      const exp = o?.props?.expiry ?? o?.props?.maturity_block;
      const fut = this.futKey(cid, exp);
      if (fut) return fut;

      return null;
    }

    /** Return a canonical market key for any inbound payload shape. */
    private resolveMarket(data: any): string | null {

      // 1) If this is a close-order envelope, be lenient with fields
      const evt = data?.event ?? data?.type ?? '';
      if (String(evt) === 'close-order') {
        // FUTURES: contract id (+ optional expiry/maturity)
        const cid =
          data?.contract_id ?? data?.contractId ??
          data?.props?.contract_id ?? data?.props?.contractId ??
          data?.order?.contract_id ?? data?.order?.contractId ??
          data?.payload?.contract_id ?? data?.payload?.contractId;

        const exp =
          data?.expiry ?? data?.maturity_block ??
          data?.props?.expiry ?? data?.props?.maturity_block ??
          data?.order?.expiry ?? data?.order?.maturity_block ??
          data?.payload?.expiry ?? data?.payload?.maturity_block;

        if (cid != null && this.futKey) {
          const fut = this.futKey(cid, exp);
          if (fut) return fut;
        }

        // SPOT: id_for_sale + id_desired
        const f =
          data?.id_for_sale ?? data?.props?.id_for_sale ??
          data?.order?.id_for_sale ?? data?.payload?.id_for_sale;
        const d =
          data?.id_desired ?? data?.props?.id_desired ??
          data?.order?.id_desired ?? data?.payload?.id_desired;

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
      traderAddress?: string;  // NEW: added field
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
        trader_address: o.traderAddress,  // NEW: bound identity
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
