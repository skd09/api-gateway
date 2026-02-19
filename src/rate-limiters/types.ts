// =================================================================
// Rate Limiter Interface — all 5 algorithms implement this
// =================================================================

export interface RateLimitResult {
    allowed: boolean;
    limit: number;  // Max requests allowed
    remaining: number; // Requests remaining in current window
    retryAfter?: number; // Seconds until client can retry (if blocked)
}

export interface RateLimiter {
    /** Check if a request from this key (IP, API key, etc.) is allowed */
    consume(key: string): Promise<RateLimitResult>;

    /** Algorithm name (for headers and dashboard) */
    name: string;
}