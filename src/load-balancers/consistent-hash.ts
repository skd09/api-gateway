import { LoadBalancer, Backend } from './types';

// =================================================================
// CONSISTENT HASHING LOAD BALANCER
// =================================================================
//
// The PROBLEM with IP Hash:
//   3 servers: hash(ip) % 3 → server index
//   Remove 1 server: hash(ip) % 2 → DIFFERENT index for almost everyone
//   ~66% of requests get reshuffled to a different server!
//
// CONSISTENT HASHING SOLUTION:
//   Place servers on a virtual ring (0 to 2^32).
//   Hash the request key → find position on ring.
//   Walk clockwise → first server you hit handles the request.
//
//       Server A (pos 100)
//            ↑
//   ─────────────────────→ Ring
//            ↓
//       Server B (pos 300)
//            ↓
//       Server C (pos 600)
//
//   Request with hash 250 → walks clockwise → hits Server B (pos 300)
//
// KEY PROPERTY:
//   Adding/removing a server only affects requests between
//   the removed server and its neighbor. ~1/N requests move.
//   (IP hash: ~(N-1)/N requests move. Huge difference!)
//
// VIRTUAL NODES:
//   One physical server → multiple positions on the ring.
//   This ensures even distribution (no hotspots).
//   Server A → positions [100, 400, 700] (3 virtual nodes)
//
// USED BY: Redis Cluster, DynamoDB, Cassandra, Memcached,
//          Akamai CDN, Discord (for routing to shards)
// =================================================================

export class ConsistentHashBalancer implements LoadBalancer {
    name = 'consistent-hash';
    private ring: Array<{ position: number; backend: Backend }> = [];
    private virtualNodes: number;

    constructor(private backends: Backend[], virtualNodes: number = 150) {
        this.virtualNodes = virtualNodes;
        this.buildRing();
    }

    private buildRing(): void {
        this.ring = [];
        const healthy = this.backends.filter(b => b.healthy !== false);

        for (const backend of healthy) {
        // Each physical server gets multiple positions on the ring
        for (let i = 0; i < this.virtualNodes; i++) {
            const key = `${backend.host}:${backend.port}:vnode${i}`;
            const position = this.hash(key);
            this.ring.push({ position, backend });
        }
        }

        // Sort ring by position for binary search
        this.ring.sort((a, b) => a.position - b.position);
    }

    select(clientIp?: string): Backend | null {
        if (this.ring.length === 0) return null;

        const key = clientIp || '127.0.0.1';
        const position = this.hash(key);

        // Binary search: find first server position >= request position
        // This is "walking clockwise on the ring"
        let low = 0;
        let high = this.ring.length - 1;

        while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (this.ring[mid].position < position) {
            low = mid + 1;
        } else {
            high = mid;
        }
        }

        // If we're past the last position, wrap around to the first
        if (this.ring[low].position < position) {
        return this.ring[0].backend;
        }

        return this.ring[low].backend;
    }

    /**
     * FNV-1a hash — fast, good distribution.
     * Must be deterministic: same input → same output.
     */
    private hash(key: string): number {
        let hash = 0x811c9dc5; // FNV offset basis
        for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned
        }
        return hash;
    }

    updateBackends(backends: Backend[]): void {
        this.backends = backends;
        this.buildRing();
    }
}