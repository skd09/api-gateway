import { RateLimiter, RateLimitResult } from './types';

// =================================================================
// LEAKY BUCKET RATE LIMITER
// =================================================================
//
// HOW IT WORKS:
//   Requests enter a queue (the "bucket").
//   The bucket "leaks" (processes) at a FIXED rate.
//   If the bucket is full → overflow → request rejected.
//
//   ┌────────────┐
//   │ ■■■■■■     │ ← 6 requests in queue (capacity: 10)
//   │            │
//   └─────┬──────┘
//         │ drip (1 request per second, constant)
//         ▼
//      processed
//
// KEY DIFFERENCE FROM TOKEN BUCKET:
//   Token Bucket: allows BURSTS (10 requests at once)
//   Leaky Bucket: SMOOTHS traffic (always 1/second, no bursts)
//
//   Token Bucket: "You can send 10 now, then wait"
//   Leaky Bucket: "You can only send at 1/second, always"
//
// IMPLEMENTATION:
//   Track queue size and last leak time.
//   On each request, calculate how many have "leaked" since last check.
//   If queue is full after leaking → reject.
//
// USED BY: Shopify API, network traffic shaping, ISPs
// =================================================================

export class LeakyBucketRateLimiter implements RateLimiter {
    name = 'leaky-bucket';
    private buckets: Map<string, { queueSize: number; lastLeak: number }> = new Map();

    constructor(
        private capacity: number = 10, // Max requests in queue
        private leakRate: number = 1, // Requests processed per second
    ){}

    async consume(key: string): Promise<RateLimitResult> {
        const now = Date.now();
        let bucket = this.buckets.get(key);

        if (!bucket) {
            bucket = { queueSize: 0, lastLeak: now };
            this.buckets.set(key, bucket);
        }

        // Calculate how many requests have "leaked" since last check
        const elapsed = (now - bucket.lastLeak) / 1000;
        const leaked = elapsed * this.leakRate;
        bucket.queueSize = Math.max(0, bucket.queueSize - leaked);
        bucket.lastLeak = now;



        if (bucket.queueSize >= this.capacity) {
            // Queue is full — request overflows
            const retryAfter = Math.ceil((bucket.queueSize - this.capacity + 1) / this.leakRate);

            return {
                allowed: false,
                limit: this.capacity,
                remaining: 0,
                retryAfter,
            };
        }

        // Add request to queue
        bucket.queueSize += 1;

        return {
            allowed: true,
            limit: this.capacity,
            remaining: Math.floor(this.capacity - bucket.queueSize),
        };
    }
    
}