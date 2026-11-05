import HyperExpress from 'hyper-express';
import crypto from 'crypto';
import { verifyBip322, canonicalAddress } from '../crypto/bip322';

// -----------------------------------------------------------------------------
// Configuration (env, read once)
// -----------------------------------------------------------------------------
const envInt = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};

const CHALLENGE_TTL_MS = envInt('TL_OB_CHALLENGE_TTL_MS', 2 * 60 * 1000);
const SESSION_TTL_MS = envInt('TL_OB_SESSION_TTL_MS', 10 * 60 * 1000);
const MAX_CHALLENGES = envInt('TL_OB_MAX_CHALLENGES', 20_000);
const MAX_SESSIONS = envInt('TL_OB_MAX_SESSIONS', 100_000);
const CHALLENGES_PER_MIN_PER_IP = envInt('TL_OB_CHALLENGES_PER_MIN', 30);
const VERIFIES_PER_MIN_PER_IP = envInt('TL_OB_VERIFIES_PER_MIN', 60);
const MAX_TRACKED_IPS = 50_000;
const MAX_BODY_BYTES = 16 * 1024;

// -----------------------------------------------------------------------------
// In-memory stores
// -----------------------------------------------------------------------------
type ChallengeRecord = {
  message: string;
  expiresAt: number;
};

export type SessionRecord = {
  address: string;
  expiresAt: number;
};

const challenges = new Map<string, ChallengeRecord>();
const sessions = new Map<string, SessionRecord>();

function pruneChallenges(now: number) {
  for (const [nonce, rec] of challenges) {
    if (now > rec.expiresAt) challenges.delete(nonce);
  }
}

function pruneSessions(now: number) {
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}

// Expired entries are also dropped by a timer so an idle server does not hold them.
const sweeper = setInterval(() => {
  const now = Date.now();
  pruneChallenges(now);
  pruneSessions(now);
}, 30_000);
sweeper.unref?.();

// -----------------------------------------------------------------------------
// Per-IP fixed-window rate limiter (bounded)
// -----------------------------------------------------------------------------
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs = 60_000) {}

  /** Returns 0 when allowed, else the seconds until the window resets. */
  take(key: string, now = Date.now()): number {
    let h = this.hits.get(key);
    if (!h || now >= h.resetAt) {
      if (!h && this.hits.size >= MAX_TRACKED_IPS) this.prune(now);
      if (!h && this.hits.size >= MAX_TRACKED_IPS) {
        // still full of live windows: refuse rather than grow without bound
        return Math.ceil(this.windowMs / 1000);
      }
      h = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
    }
    if (h.count >= this.limit) return Math.max(1, Math.ceil((h.resetAt - now) / 1000));
    h.count++;
    return 0;
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (now >= h.resetAt) this.hits.delete(k);
  }
}

const challengeLimiter = new RateLimiter(CHALLENGES_PER_MIN_PER_IP);
const verifyLimiter = new RateLimiter(VERIFIES_PER_MIN_PER_IP);

/** Rate-limit key: the socket's remote address (never a forwarded header); IPv6 collapses to its /64. */
function clientKey(req: HyperExpress.Request): string {
  let ip = '';
  try { ip = String((req as any).ip || ''); } catch { /* socket already gone */ }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  return ip || 'unknown';
}

// -----------------------------------------------------------------------------
// Exported helpers for SocketManager integration
// -----------------------------------------------------------------------------

/**
 * Lookup a session by token.
 * Returns null if not found or expired.
 * Used by SocketManager for WebSocket auth handshake.
 */
export function getSessionForToken(token: string): SessionRecord | null {
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  return session;
}

/**
 * Validate session and return address.
 * Convenience wrapper for simple checks.
 */
export function validateSession(token: string): { valid: boolean; address?: string; expiresAt?: number } {
  const session = getSessionForToken(token);
  if (!session) {
    return { valid: false };
  }
  return { valid: true, address: session.address, expiresAt: session.expiresAt };
}

/**
 * Revoke a session (logout).
 */
export function revokeSession(token: string): boolean {
  return sessions.delete(token);
}

/**
 * Get session count (for monitoring).
 */
export function getActiveSessionCount(): number {
  pruneSessions(Date.now());
  return sessions.size;
}

/** Sizes of the in-memory stores (for monitoring). */
export function authStoreSizes() {
  return { challenges: challenges.size, sessions: sessions.size };
}

function bearer(req: HyperExpress.Request): string | undefined {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

async function readJson(req: HyperExpress.Request): Promise<any> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Routes (HyperExpress router, mounted at /auth by routes.ts on every listener)
// -----------------------------------------------------------------------------
const router = new HyperExpress.Router();

// GET /auth/challenge
router.get('/challenge', (req, res) => {
  const now = Date.now();
  const wait = challengeLimiter.take(clientKey(req), now);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate limited' });
  }

  if (challenges.size >= MAX_CHALLENGES) pruneChallenges(now);
  if (challenges.size >= MAX_CHALLENGES) {
    return res.status(503).json({ error: 'too many pending challenges' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = now + CHALLENGE_TTL_MS;
  const message =
`TradeLayer session authentication
nonce=${nonce}
expires=${expiresAt}`;

  challenges.set(nonce, { message, expiresAt });
  res.json({ nonce, message, expiresAt });
});

// POST /auth/verify   body: { address, message, signature }
router.post('/verify', { max_body_length: MAX_BODY_BYTES }, async (req, res) => {
  const now = Date.now();
  const wait = verifyLimiter.take(clientKey(req), now);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate limited' });
  }

  const body = await readJson(req);
  if (body === null) return res.status(400).json({ error: 'invalid json' });

  const { address, message, signature } = body;
  if (typeof address !== 'string' || typeof message !== 'string' || typeof signature !== 'string' ||
      !address || !message || !signature) {
    return res.status(400).json({ error: 'missing fields' });
  }

  const nonce = message.match(/nonce=([a-f0-9]+)/)?.[1];
  if (!nonce) {
    return res.status(400).json({ error: 'nonce missing' });
  }

  const record = challenges.get(nonce);
  if (!record) {
    return res.status(400).json({ error: 'invalid or used challenge' });
  }

  // A challenge is single use: it is consumed by the first verify attempt, valid or not.
  challenges.delete(nonce);

  if (now > record.expiresAt) {
    return res.status(400).json({ error: 'challenge expired' });
  }

  if (record.message !== message) {
    return res.status(400).json({ error: 'message mismatch' });
  }

  if (!verifyBip322({ address, message, signature })) {
    return res.status(401).json({ error: 'signature invalid' });
  }

  // Create session
  if (sessions.size >= MAX_SESSIONS) {
    pruneSessions(now);
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;
  const canonical = canonicalAddress(address);
  sessions.set(token, { address: canonical, expiresAt });

  // `token` and `sessionToken` carry the same value (clients read either)
  res.json({ sessionToken: token, token, expiresAt, address: canonical });
});

// POST /auth/logout (revoke session)
router.post('/logout', { max_body_length: MAX_BODY_BYTES }, async (req, res) => {
  const body = await readJson(req);
  const token = (body && typeof body.token === 'string' ? body.token : undefined) || bearer(req);
  if (!token) {
    return res.status(400).json({ error: 'missing token' });
  }
  res.json({ revoked: revokeSession(token) });
});

// GET /auth/status (check session validity)
router.get('/status', (req, res) => {
  const token = bearer(req);
  if (!token) return res.json({ authenticated: false });
  const result = validateSession(token);
  res.json({
    authenticated: result.valid,
    address: result.address,
    expiresAt: result.expiresAt,
  });
});

export { router as authRouter };

// -----------------------------------------------------------------------------
// HyperExpress middleware for REST routes that need a session
// -----------------------------------------------------------------------------
export function requireSession(req: HyperExpress.Request, res: HyperExpress.Response, next: () => void) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'missing auth token' });

  const session = getSessionForToken(token);
  if (!session) return res.status(401).json({ error: 'invalid or expired session' });

  (req as any).session = session;
  next();
}
