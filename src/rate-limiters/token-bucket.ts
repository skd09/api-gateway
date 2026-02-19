import { RateLimiter, RateLimitResult } from './types';

// =================================================================
// TOKEN BUCKET RATE LIMITER
// =================================================================
//
// HOW IT WORKS:
//   Imagine a bucket that holds tokens.
//   - Tokens are ADDED at a constant rate (e.g., 10/second)
//   - Each request REMOVES one token
//   - If bucket is empty → request rejected
//   - Bucket has a MAX capacity (can't accumulate forever)
//
//   ┌────────────┐
//   │ ●●●●●●●●   │ ← 8 tokens available
//   │ capacity:10 │
//   └────────────┘
//         │
//     +10/second refill
//
//   Request comes in → take 1 token → 7 remaining
//   10 requests at once → all 10 use tokens → allowed (burst!)
//   11th request → no tokens → rejected
//   Wait 0.1s → 1 token refilled → next request allowed
//
// KEY PROPERTY: ALLOWS BURSTS
//   If bucket is full (10 tokens), client can send 10 requests
//   all at once. Then they must wait for refill.
//   This is great for APIs where clients send batches.
//
// IMPLEMENTATION TRICK:
//   We don't actually run a timer to add tokens.
//   On each request, we CALCULATE how many tokens have been
//   added since the last request. This is called "lazy refill."
//
// USED BY: AWS API Gateway, Google Cloud API, many CDNs
// =================================================================

export class TokenBucketRateLimiter implements RateLimiter {
    name = 'token-bucket';
    private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

    constructor(
        private capacity: number = 10, // Max tokens in bucket
        private refillRate: number = 1, // Tokens added per second
    ){}

    async consume(key: string): Promise<RateLimitResult> {
        const now = Date.now();
        let bucket = this.buckets.get(key);

        if (!bucket) {
            // New client gets a full bucket
            bucket = { tokens: this.capacity, lastRefill: now };
            this.buckets.set(key, bucket);
        }

        // Lazy refill: calculate tokens added since last request
        const elapsed = (now - bucket.lastRefill) / 1000; // seconds
        const tokensToAdd = elapsed * this.refillRate;
        bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;

        if (bucket.tokens < 1) {
            // How long until 1 token is available?
            const retryAfter = Math.ceil((1 - bucket.tokens) / this.refillRate);

            return {
                allowed: false,
                limit: this.capacity,
                remaining: 0,
                retryAfter,
            };
        }

        // Consume one token
        bucket.tokens -= 1;

        return {
            allowed: true,
            limit: this.capacity,
            remaining: Math.floor(bucket.tokens),
        };
    }
    
}