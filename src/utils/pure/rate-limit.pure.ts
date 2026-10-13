// Every limiter instance, so that a key (a socket id) can be released from all of
// them at once. Limiters are created once at module load, so this does not grow.
const allLimiters = new Set<TokenBucketLimiter>();

// Minimal dependency-free token bucket used to rate limit socket event traffic
// per connection. One instance is kept per event family so that a burst of one
// kind of traffic cannot starve another (e.g. order placement vs swap relay vs
// orderbook queries).
export class TokenBucketLimiter {
    private buckets = new Map<string, { tokens: number; lastRefill: number }>();

    constructor(
        private ratePerSec: number,
        private burst: number,
    ) {
        allLimiters.add(this);
    }

    // Releases the bucket held for `key` in every limiter (see releaseKeyFromAllLimiters).
    private dropKey(key: string): void {
        this.buckets.delete(key);
    }

    static releaseKeyFromAll(key: string): void {
        allLimiters.forEach(limiter => limiter.dropKey(key));
    }

    consume(key: string): boolean {
        const now = Date.now();
        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = { tokens: this.burst, lastRefill: now };
            this.buckets.set(key, bucket);
        }
        bucket.tokens = Math.min(
            this.burst,
            bucket.tokens + ((now - bucket.lastRefill) / 1000) * this.ratePerSec,
        );
        bucket.lastRefill = now;
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }
}
