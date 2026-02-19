import { RateLimitResult, RateLimiter } from "./types";

// =================================================================
// FIXED WINDOW RATE LIMITER
// =================================================================
//
// HOW IT WORKS:
//   Divide time into fixed windows (e.g., 1-minute windows).
//   Count requests per window. Reset at window boundary.
//
//   Window 10:00-10:01: [■■■■■■■■] 80/100 → allowed
//   Window 10:01-10:02: [■■       ] 20/100 → allowed
//
// IMPLEMENTATION:
//   Key: "ratelimit:fixed:<clientIP>:<windowNumber>"
//   windowNumber = Math.floor(Date.now() / windowSizeMs)
//   Each new window gets a fresh counter.
//
// PROBLEM — BOUNDARY BURST:
//   Client sends 100 requests at 10:00:59 (end of window).
//   Window resets at 10:01:00.
//   Client sends 100 more at 10:01:01.
//   Result: 200 requests in 2 seconds! Limit is supposed to be 100/min.
//
// PROS: Very simple, O(1) memory per client
// CONS: Boundary burst problem
//
// USED BY: Simple APIs, when exact precision isn't critical
// =================================================================

export class FixedWindowRateLimiter implements RateLimiter {

    name = 'fixed-window';
    private windows: Map<string, {count: number; expiresAt: number}> = new Map();

    constructor(
        private maxRequests: number = 100,
        private windowMs: number = 60000 // per 60 seconds
    ){}
    
    async consume(key: string): Promise<RateLimitResult> {
        const now = Date.now();
        const windowKey = `${key}:${Math.floor(now / this.windowMs)}`;

        let window = this.windows.get(windowKey);

        // New window or expired window
        if(!window || now > window.expiresAt){
            // Clean up old windows
            this.cleanup();
            window = {
                count: 0,
                expiresAt: (Math.floor(now / this.windowMs) + 1) * this.windowMs
            };
            this.windows.set(windowKey, window);
        }

        window.count++;

        if(window.count > this.maxRequests) {
            const retryAfter = Math.ceil((window.expiresAt - now) / 1000);
            return {
                allowed: false,
                limit: this.maxRequests,
                remaining: 0,
                retryAfter
            };
        }

        return {
            allowed: true,
            limit: this.maxRequests,
            remaining: this.maxRequests - window.count,
        };
    }

    private cleanup(): void {
        const now = Date.now();
        for(const [key, window] of this.windows){
            if(now > window.expiresAt) {
                this.windows.delete(key);
            }
        }
    }
}