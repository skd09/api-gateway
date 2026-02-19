import { GatewayMiddleware, GatewayContext, NextFunction } from './types';

// =================================================================
// CORS MIDDLEWARE
// =================================================================
// Adds CORS headers to ALL responses (even 429, 503).
// Handles preflight OPTIONS requests.
// =================================================================

export class CorsMiddleware implements GatewayMiddleware {
    name = 'cors';

    constructor(
        private allowedOrigins: string[] = ['*'],
        private allowedMethods: string[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    ) {}

    async handle(ctx: GatewayContext, next: NextFunction): Promise<void> {
        const { req, res } = ctx;
        const origin = req.headers.origin || '*';

        // Set CORS headers on every response
        const allowedOrigin = this.allowedOrigins.includes('*') ? '*' : this.allowedOrigins.includes(origin) ? origin : '';

        if (allowedOrigin) {
            res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
            res.setHeader('Access-Control-Allow-Methods', this.allowedMethods.join(', '));
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
            res.setHeader('Access-Control-Max-Age', '86400');
        }

        // Handle preflight
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return; // Don't call next() — short-circuit
        }

        await next();
    }
}