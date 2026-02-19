import { GatewayMiddleware, GatewayContext, NextFunction } from './types';

// =================================================================
// LOGGER MIDDLEWARE
// =================================================================
// Runs FIRST — logs every request, even rejected ones.
// Logs again AFTER the response to capture timing and status.
// =================================================================

export class LoggerMiddleware implements GatewayMiddleware {
    name = 'logger';

    async handle(ctx: GatewayContext, next: NextFunction): Promise<void> {
        const { req, res, startTime } = ctx;

        // Log AFTER response is sent
        res.on('finish', () => {
            const elapsed = Date.now() - startTime;
            const backend = ctx.backend ? ctx.backend.name : 'none';
            const status = res.statusCode;
            console.log(
                `${req.method} ${req.originalUrl} → ${backend} [${status}] ${elapsed}ms`
            );
        });

        await next();
    }
} 