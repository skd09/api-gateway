import { GatewayContext, GatewayMiddleware } from './types';
import { Request, Response } from 'express';

// =================================================================
// MIDDLEWARE PIPELINE
// =================================================================
//
// Chains middleware together in order.
// Each middleware calls next() to continue, or doesn't to stop.
//
// This is EXACTLY how Express middleware works internally.
// We build it ourselves so you understand the pattern.
//
//   pipeline.use(logger);       // 1st
//   pipeline.use(cors);         // 2nd
//   pipeline.use(rateLimit);    // 3rd — might stop here (429)
//   pipeline.use(circuitBreak); // 4th — might stop here (503)
//   pipeline.use(proxy);        // 5th — final destination
//
// The order MATTERS:
//   Logger runs first (always logs, even rejected requests)
//   CORS runs second (rejected responses still need CORS headers)
//   Rate limit before circuit breaker (cheap check before expensive one)
//   Proxy is always last (the actual work)
// =================================================================

export class MiddlewarePipeline {
    private middleware: GatewayMiddleware[] = [];

    use(mw: GatewayMiddleware): MiddlewarePipeline {
        this.middleware.push(mw);
        return this; // Chainable: pipeline.use(a).use(b).use(c)
    }

    /**
     * Execute the pipeline for a request.
     * Each middleware gets a next() that calls the NEXT middleware.
     * This creates a recursive chain.
     */
    async execute(req: Request, res: Response): Promise<void> {
        const ctx: GatewayContext = {
            req,
            res,
            startTime: Date.now(),
            clientKey: req.ip || req.headers['x-forwarded-for'] as string || 'unknown',
            meta: {},
        };

        // Build the chain from the inside out
        let index = 0;

        const next = async (): Promise<void> => {
        if (index >= this.middleware.length) return;

            const mw = this.middleware[index];
            index++;

            try {
                await mw.handle(ctx, next);
            } catch (err: any) {
                console.error(`Middleware [${mw.name}] error: ${err.message}`);

                if (!res.headersSent) {
                    res.status(500).json({
                        error: 'Internal Gateway Error',
                        middleware: mw.name,
                        message: err.message,
                    });
                }
            }
        };

        await next();
    }

    getMiddlewareNames(): string[] {
        return this.middleware.map(m => m.name);
    }
}