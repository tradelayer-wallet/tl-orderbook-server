import { TokenBucketLimiter } from "../../utils/pure/rate-limit.pure";

// Swap relay traffic is rate limited per emitting socket so a client cannot use
// the relay as a bandwidth amplifier against its counterparty.
export const swapRelayLimiter = new TokenBucketLimiter(10, 50);
