import { LoadBalancer, Backend } from './types';

// =================================================================
// LEAST CONNECTIONS LOAD BALANCER
// =================================================================
//
// Send each request to the server with the fewest ACTIVE connections.
//
//   Server A: 5 active requests
//   Server B: 2 active requests  ← PICK THIS
//   Server C: 8 active requests
//
// WHY NOT JUST ROUND ROBIN?
//   If Server C is slow (processing takes 10s instead of 1s),
//   round robin keeps sending it equal traffic.
//   Least connections naturally avoids overloaded servers.
//
// IMPLEMENTATION:
//   Track activeConnections per server.
//   On request: select server with lowest count, increment.
//   On response: decrement count.
//
// USED BY: HAProxy, AWS NLB, most production load balancers
// =================================================================

export class LeastConnectionsBalancer implements LoadBalancer {
    name = 'least-connections';
    private connections: Map<string, number> = new Map();

    constructor(private backends: Backend[]) {
        for (const b of backends) {
            this.connections.set(`${b.host}:${b.port}`, 0);
        }
    }

    select(): Backend | null {
        const healthy = this.backends.filter(b => b.healthy !== false);
        if (healthy.length === 0) return null;

        // Find server with fewest active connections
        let minBackend = healthy[0];
        let minConns = this.getConnections(minBackend);

        for (const backend of healthy) {
            const conns = this.getConnections(backend);
            if (conns < minConns) {
                minConns = conns;
                minBackend = backend;
            }
        }

        // Increment active connections
        const key = `${minBackend.host}:${minBackend.port}`;
        this.connections.set(key, (this.connections.get(key) || 0) + 1);

        return minBackend;
    }

    onRequestComplete(backend: Backend): void {
        const key = `${backend.host}:${backend.port}`;
        const current = this.connections.get(key) || 0;
        this.connections.set(key, Math.max(0, current - 1));
    }

    getConnections(backend: Backend): number {
        return this.connections.get(`${backend.host}:${backend.port}`) || 0;
    }

    updateBackends(backends: Backend[]): void {
        this.backends = backends;
    }
}