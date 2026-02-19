import { GatewayMiddleware, GatewayContext, NextFunction } from './types';
import http from 'http';
import { LoadBalancer } from '../load-balancers/types';

// =================================================================
// PROXY MIDDLEWARE — Final step in the pipeline
// =================================================================
// Takes the backend selected by circuit-breaker middleware
// and forwards the request. Records success/failure for the
// circuit breaker.
// =================================================================

export class ProxyMiddleware implements GatewayMiddleware {
    name = 'proxy';

    constructor(
        private loadBalancers: Record<string, LoadBalancer>,
        private getActiveLB: () => string,
        private metrics: { proxied: number; errors: number; byBackend: Record<string, number> },
    ) {}

    async handle(ctx: GatewayContext, next: NextFunction): Promise<void> {
        const { req, res, backend, circuitBreaker: cb } = ctx;

        if (!backend || !cb) {
            res.status(500).json({ error: 'No backend selected' });
            return;
        }

        return new Promise<void>((resolve) => {
            const options: http.RequestOptions = {
                hostname: backend.host,
                port: backend.port,
                path: req.originalUrl,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: `${backend.host}:${backend.port}`,
                },
                timeout: 5000,
            };

            const backendReq = http.request(options, (backendRes) => {
                const elapsed = Date.now() - ctx.startTime;
                if (backendRes.statusCode && backendRes.statusCode >= 500) {
                    cb.onFailure();
                } else {
                    cb.onSuccess();
                }

                res.setHeader('x-gateway', 'api-gateway-v5');
                res.setHeader('x-backend', backend.name);
                res.setHeader('x-backend-port', String(backend.port));
                res.setHeader('x-response-time', `${elapsed}ms`);
                res.setHeader('x-lb-algorithm', ctx.meta.loadBalancer || '');
                res.setHeader('x-circuit-state', cb.getState());

                res.writeHead(backendRes.statusCode || 500, backendRes.headers);
                backendRes.pipe(res);

                this.metrics.proxied++;
                this.metrics.byBackend[backend.name] = (this.metrics.byBackend[backend.name] || 0) + 1;

                const lb = this.loadBalancers[this.getActiveLB()];
                if (lb.onRequestComplete) lb.onRequestComplete(backend);

                backendRes.on('end', resolve);
            });

            backendReq.on('timeout', () => {
                backendReq.destroy();
                cb.onFailure();

                const lb = this.loadBalancers[this.getActiveLB()];
                if (lb.onRequestComplete) lb.onRequestComplete(backend);

                if (!res.headersSent) {
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Gateway Timeout',
                        message: `${backend.name} did not respond in time`,
                    }));
                }
                resolve();
            });

            backendReq.on('error', (err) => {
                this.metrics.errors++;
                cb.onFailure();

                const lb = this.loadBalancers[this.getActiveLB()];
                if (lb.onRequestComplete) lb.onRequestComplete(backend);

                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Bad Gateway',
                        message: `${backend.name} is unavailable`,
                    }));
                }
                resolve();
            });

            req.pipe(backendReq);
        });
    }
}