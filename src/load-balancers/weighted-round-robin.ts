import { LoadBalancer, Backend } from './types';

// =================================================================
// WEIGHTED ROUND ROBIN
// =================================================================
//
// Like round robin, but servers with higher weight get more traffic.
//
//   Server A (weight: 3) → gets 3 out of every 6 requests
//   Server B (weight: 2) → gets 2 out of every 6 requests
//   Server C (weight: 1) → gets 1 out of every 6 requests
//
// HOW: Expand the list based on weights, then round robin.
//   [A, A, A, B, B, C] → rotate through this
//
// USE CASE: Mixed hardware — beefy server A handles 3x more than server C
//
// USED BY: Nginx (upstream weight), HAProxy, AWS ALB (target weights)
// =================================================================

export class WeightedRoundRobinBalancer implements LoadBalancer {
    name = 'weighted-round-robin';
    private index = 0;
    private weightedList: Backend[] = [];

    constructor(private backends: Backend[]) {
        this.buildWeightedList();
    }

    private buildWeightedList(): void {
        this.weightedList = [];
        const healthy = this.backends.filter(b => b.healthy !== false);

        for (const backend of healthy) {
            const weight = backend.weight || 1;
            for (let i = 0; i < weight; i++) {
                this.weightedList.push(backend);
            }
        }
    }

    select(): Backend | null {
        if (this.weightedList.length === 0) return null;

        const backend = this.weightedList[this.index % this.weightedList.length];
        this.index++;

        return backend;
    }

    updateBackends(backends: Backend[]): void {
        this.backends = backends;
        this.buildWeightedList();
    }
}