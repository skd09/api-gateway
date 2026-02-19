import { RateLimiter, RateLimitResult } from './types';

// =================================================================
// SLIDING WINDOW LOG RATE LIMITER
// =================================================================
//
// HOW IT WORKS:
//   Store the TIMESTAMP of every request.
//   To check: count timestamps in the last N seconds.
//
//   Timestamps: [10:00:01, 10:00:15, 10:00:30, 10:00:45, 10:01:02]
//   Now = 10:01:10, window = 60s
//   Remove timestamps before 10:00:10 → [10:00:15, 10:00:30, 10:00:45, 10:01:02]
//   Count = 4, limit = 100 → allowed
//
// PROS: Perfectly accurate — no boundary burst problem
// CONS: Stores every timestamp — O(N) memory where N = request count
//       At 100 req/min with 10K users = 1M timestamps in memory
//
// USED BY: When you need exact precision and have few clients
// =================================================================

export class SlidingLogRateLimiter implements RateLimiter {
    name = 'sliding-log';
    private logs: Map<String, number[]>= new Map();

    constructor(
        private maxRequests: number = 100,
        private windowMs: number = 60000
    ){}

    async consume(key: string): Promise<RateLimitResult> {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // Get or create log for this key
        let timestamps = this.logs.get(key) || [];

        // Remove timestamps outside the window
        timestamps = timestamps.filter(t => t > windowStart);

        if (timestamps.length >= this.maxRequests) {
            // Find when the oldest request in window will expire
            const oldestInWindows = timestamps[0];
            const retryAfter = Math.ceil((oldestInWindows + this.windowMs - now) / 1000);

            this.logs.set(key, timestamps);

            return {
                allowed: false,
                limit: this.maxRequests,
                remaining: 0,
                retryAfter: Math.max(retryAfter, 1),
            };
        }
        
        // Add current timestamp
        timestamps.push(now);
        this.logs.set(key, timestamps);

        return {
            allowed: true,
            limit: this.maxRequests,
            remaining: this.maxRequests - timestamps.length,
        };
    }
    
}