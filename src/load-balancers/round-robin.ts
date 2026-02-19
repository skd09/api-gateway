import { LoadBalancer, Backend } from './types';

// =================================================================
// ROUND ROBIN LOAD BALANCER
// =================================================================
//
// Simplest possible algorithm: rotate through servers in order.
//
//   Request 1 → Server A
//   Request 2 → Server B
//   Request 3 → Server C
//   Request 4 → Server A (wraps around)
//
// PROS: Dead simple, perfectly even distribution
// CONS: Ignores server capacity, ignores current load
//       A slow server gets the same traffic as a fast one
//
// USED BY: Nginx default, most basic load balancers
// =================================================================

export class RoundRobinBalancer implements LoadBalancer {
    name = 'round-robin';
    private index = 0;

    constructor(private backends: Backend[]) {}

    select(): Backend | null {
        const healthy = this.backends.filter(b => b.healthy !== false);
        if (healthy.length === 0) return null;

        const backend = healthy[this.index % healthy.length];
        this.index++;

        return backend;
    }

    updateBackends?(backends: Backend[]): void {
        this.backends = backends
    }
}