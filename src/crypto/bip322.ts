import { native } from '../native';

export type Bip322Request = {
  address: string;
  message: string;
  /** base64 witness stack ("smp" prefix optional), "ful" full transaction, or base64 BIP-137 (P2PKH only) */
  signature: string;
  /** btc | tbtc | rbtc | ltc | tltc | rltc | auto (default: TL_OB_AUTH_NETWORK, else auto) */
  network?: string;
};

const DEFAULT_NETWORK = (process.env.TL_OB_AUTH_NETWORK || 'auto').trim();
const MAX_ADDRESS = 120;
const MAX_MESSAGE = 4096;
const MAX_SIGNATURE = 8192;

/**
 * Verifies a BIP-322 (simple or full) or BIP-137 (P2PKH) signature in the native addon.
 * Supports P2WPKH, P2SH-P2WPKH, P2TR key path and P2PKH on Bitcoin and Litecoin.
 * Returns false for any malformed or unsupported input and never throws.
 */
export function verifyBip322(req: Bip322Request): boolean {
  const { address, message, signature } = req;
  if (typeof address !== 'string' || typeof message !== 'string' || typeof signature !== 'string') return false;
  if (!address || address.length > MAX_ADDRESS) return false;
  if (message.length > MAX_MESSAGE || !signature || signature.length > MAX_SIGNATURE) return false;
  try {
    return native.verifyBip322(address, message, signature, req.network ?? DEFAULT_NETWORK) === true;
  } catch {
    return false;
  }
}

/** Bech32 addresses are case-insensitive; base58 addresses are case-sensitive and left alone. */
export function canonicalAddress(address: string): string {
  const a = String(address ?? '').trim();
  return /^(bc|tb|bcrt|ltc|tltc|rltc)1/i.test(a) ? a.toLowerCase() : a;
}
