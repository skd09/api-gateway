import { GatewayMiddleware, GatewayContext, NextFunction } from './types';
import { RateLimiter } from '../rate-limiters/types';

// =================================================================
// RATE LIMIT MIDDLEWARE
// =================================================================
// Checks the active rate limiter. If exceeded, returns 429.
// Does NOT call next() on rejection — stops the pipeline.
// =================================================================

export class RateLimitMiddleware implements GatewayMiddleware {
    name = 'rate-limit';

    constructor(
        private rateLimiters: Record<string, RateLimiter>,
        private getActive: () => string,
    ) {}

    async handle(ctx: GatewayContext, next: NextFunction): Promise<void> {
        const { res, clientKey } = ctx;   
        const limiterName = this.getActive();
        const limiter = this.rateLimiters[limiterName];

        const result = await limiter.consume(clientKey);

        // Always set rate limit headers (industry standard)
        res.setHeader('X-RateLimit-Limit', result.limit);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Algorithm', limiter.name);

        if(!result.allowed) {
            res.setHeader('Retry-After', result.retryAfter || 1);

            ctx.meta.rateLimited = true;

            res.status(429).json({
                error: 'Too Many Requests',
                algorithm: limiter.name,
                retryAfter: result.retryAfter,
            });
            return; // STOP — don't call next()
        }

        await next();
    }
}