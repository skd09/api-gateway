import { GatewayMiddleware, GatewayContext, NextFunction } from './types';
import { Backend } from '../load-balancers/types';
import { LoadBalancer } from '../load-balancers/types';
import { CircuitBreaker } from '../circuit-breaker/circuit-breaker';

// =================================================================
// CIRCUIT BREAKER + LOAD BALANCER MIDDLEWARE
// =================================================================
// Selects a backend using the load balancer, then checks its
// circuit breaker. If all circuits are open, returns 503.
// Sets ctx.backend and ctx.circuitBreaker for the proxy middleware.
// =================================================================

export class CircuitBreakerMiddleware implements GatewayMiddleware {
    name = 'circuit-breaker';
    

    constructor(
        private backends: Backend[],
        private circuitBreakers: Record<string, CircuitBreaker>,
        private loadBalancers: Record<string, LoadBalancer>,
        private getActiveLB: () => string,
    ) {}

    async handle(ctx: GatewayContext, next: NextFunction): Promise<void> {
        const lb = this.loadBalancers[this.getActiveLB()];

        // Try to find a backend with a non-open circuit
        for (let attempt = 0; attempt < this.backends.length; attempt++) {
            const backend = lb.select(ctx.clientKey);
            if(!backend) break;

            const cb = this.circuitBreakers[backend.name];

            if(cb.canRequest()) {
                // Found a usable backend — attach to context
                ctx.backend = backend;
                ctx.circuitBreaker = cb;
                ctx.meta.loadBalancer = this.getActiveLB();

                await next();
                return;
            }
        }
        
        // All circuits open
        ctx.meta.allCircuitsOpen = true;

        ctx.res.status(503).json({
            error: 'Service Unavailable',
            message: 'All backend circuits are open. System is recovering.',
            circuits: Object.fromEntries(
                Object.entries(this.circuitBreakers).map(([k, v]) => [k, v.getState()])
            ),
        });
    }
}