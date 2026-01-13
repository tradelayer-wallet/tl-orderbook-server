import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { verifyBip322 } from '../crypto/bip322';

// -----------------------------------------------------------------------------
// In-memory stores
// -----------------------------------------------------------------------------

type ChallengeRecord = {
  message: string;
  expiresAt: number;
};

type SessionRecord = {
  address: string;
  expiresAt: number;
};

const challenges = new Map<string, ChallengeRecord>();
const sessions = new Map<string, SessionRecord>();

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function authRoute(server: FastifyInstance) {

  // GET /auth/challenge
  server.get('/challenge', async (_req, reply) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 2 * 60 * 1000;

    const message =
`TradeLayer session authentication
nonce=${nonce}
expires=${expiresAt}`;

    challenges.set(nonce, { message, expiresAt });

    return reply.send({ nonce, message, expiresAt });
  });

  // POST /auth/verify
  server.post(
    '/verify',
    async (
      req: FastifyRequest<{
        Body: {
          address: string;
          message: string;
          signature: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      const { address, message, signature } = req.body ?? {};

      if (!address || !message || !signature) {
        return reply.status(400).send({ error: 'missing fields' });
      }

      const nonce = message.match(/nonce=([a-f0-9]+)/)?.[1];
      if (!nonce) {
        return reply.status(400).send({ error: 'nonce missing' });
      }

      const record = challenges.get(nonce);
      if (!record) {
        return reply.status(400).send({ error: 'invalid or used challenge' });
      }

      if (Date.now() > record.expiresAt) {
        challenges.delete(nonce);
        return reply.status(400).send({ error: 'challenge expired' });
      }

      if (record.message !== message) {
        return reply.status(400).send({ error: 'message mismatch' });
      }

      const ok = await verifyBip322({ address, message, signature });
      if (!ok) {
        return reply.status(401).send({ error: 'signature invalid' });
      }

      challenges.delete(nonce);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 10 * 60 * 1000;

      sessions.set(token, { address, expiresAt });

      return reply.send({ sessionToken: token, expiresAt });
    }
  );
}

// -----------------------------------------------------------------------------
// Fastify-native middleware
// -----------------------------------------------------------------------------

export async function requireSession(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'missing auth token' });
    return;
  }

  const token = auth.slice(7);
  const session = sessions.get(token);

  if (!session) {
    reply.status(401).send({ error: 'invalid session' });
    return;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    reply.status(401).send({ error: 'session expired' });
    return;
  }

  (req as any).session = session;
}

// auth.route.ts
export function getSessionForToken(token: string) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s;
}

