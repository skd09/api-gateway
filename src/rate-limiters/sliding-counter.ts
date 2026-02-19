import { RateLimiter, RateLimitResult } from './types';

// =================================================================
// SLIDING WINDOW COUNTER RATE LIMITER
// =================================================================
//
// HOW IT WORKS:
//   Combines fixed window simplicity with sliding window accuracy.
//   Uses a WEIGHTED AVERAGE of current and previous windows.
//
//   Previous window (10:00-10:01): 84 requests
//   Current window  (10:01-10:02): 36 requests
//   Current time: 10:01:15 (25% into current window)
//
//   Estimate = previous × (1 - elapsed%) + current
//            = 84 × 0.75 + 36
//            = 63 + 36 = 99
//
//   Limit is 100, so 99 < 100 → allowed!
//
// WHY THIS IS THE BEST:
//   - O(1) memory (just 2 counters per client, like fixed window)
//   - Much more accurate than fixed window (no boundary burst)
//   - Slightly less accurate than sliding log (it's an estimate)
//   - Cloudflare, Stripe, and most production APIs use this
//
// USED BY: Cloudflare, Stripe, most production rate limiters
// =================================================================

export class SlidingCounterRateLimiter implements RateLimiter {
    name = 'sliding-counter';
    private windows: Map<string, { count: number; windowStart: number }> = new Map();

    constructor(
        private maxRequests: number = 100,
        private windowMs: number = 60000
    ){}

    async consume(key: string): Promise<RateLimitResult> {
        const now = Date.now();
        const currentWindowStart = Math.floor(now / this.windowMs) * this.windowMs;
        const previousWindowStart = currentWindowStart - this.windowMs;

        const currentKey = `${key}:current`;
        const previousKey = `${key}:previous`;

        // Get current and previous window counts
        let current = this.windows.get(currentKey);
        let previous = this.windows.get(previousKey);

        // Handle window transitions
        if (!current || current.windowStart !== currentWindowStart) {
            // Move current to previous
            if (current && current.windowStart === previousWindowStart) {
                this.windows.set(previousKey, current);
                previous = current;
            } else if (!previous || previous.windowStart !== previousWindowStart) {
                previous = { count: 0, windowStart: previousWindowStart };
                this.windows.set(previousKey, previous);
            }

            current = { count: 0, windowStart: currentWindowStart };
            this.windows.set(currentKey, current);
        }

        if (!previous || previous.windowStart !== previousWindowStart) {
            previous = { count: 0, windowStart: previousWindowStart };
        }

        // Calculate weighted estimate
        const elapsedInCurrentWindow = now - currentWindowStart;
        const previousWeight = 1 - (elapsedInCurrentWindow / this.windowMs);
        const estimate = Math.floor(previous.count * previousWeight) + current.count;

        if (estimate >= this.maxRequests) {
            const retryAfter = Math.ceil((this.windowMs - elapsedInCurrentWindow) / 1000);

            return {
                allowed: false,
                limit: this.maxRequests,
                remaining: 0,
                retryAfter: Math.max(retryAfter, 1),
            };
        }

        current.count++;

        return {
            allowed: true,
            limit: this.maxRequests,
            remaining: this.maxRequests - estimate - 1,
        };
    }
}