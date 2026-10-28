import { TokenBucketLimiter } from "../../utils/pure/rate-limit.pure";

// Per-socket token buckets, one family per kind of traffic so a burst of one kind
// cannot starve another. Each is keyed by socket id.
const ORDER_RATE_PER_SEC = 10;
const ORDER_RATE_BURST = 100;
const QUERY_RATE_PER_SEC = 10;
const QUERY_RATE_BURST = 50;
const SWAP_RELAY_RATE_PER_SEC = 10;
const SWAP_RELAY_RATE_BURST = 50;

export const orderRateLimiter = new TokenBucketLimiter(ORDER_RATE_PER_SEC, ORDER_RATE_BURST);
export const queryRateLimiter = new TokenBucketLimiter(QUERY_RATE_PER_SEC, QUERY_RATE_BURST);
// Swap relay traffic is limited per emitting socket so a client cannot use the
// relay as a bandwidth amplifier against its counterparty.
export const swapRelayLimiter = new TokenBucketLimiter(SWAP_RELAY_RATE_PER_SEC, SWAP_RELAY_RATE_BURST);

// Releases the buckets of a socket in every limiter, including any created later.
// Called from the single socket disconnect hook (SocketManager.onDisconnect).
export const releaseSocketLimiters = (socketId: string): void => {
    TokenBucketLimiter.releaseKeyFromAll(socketId);
};
