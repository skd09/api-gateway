import { LoadBalancer, Backend } from './types';

// =================================================================
// IP HASH LOAD BALANCER
// =================================================================
//
// Hash the client's IP address → always route to the same server.
//
//   hash("10.0.0.1") % 3 = 0 → always Server A
//   hash("10.0.0.2") % 3 = 2 → always Server C
//   hash("10.0.0.3") % 3 = 1 → always Server B
//
// WHY: Session affinity (sticky sessions).
//   If Server A has user's session in memory, every request
//   from that user MUST go to Server A.
//
// PROBLEM: If Server A dies, ALL its users get redistributed.
//   hash("10.0.0.1") % 2 = ??? (different server now)
//   This is what Consistent Hashing solves.
//
// USED BY: Nginx ip_hash, when you need sticky sessions
// =================================================================

export class IpHashBalancer implements LoadBalancer {
    name = 'ip-hash';

    constructor(private backends: Backend[]) {}

    select(clientIp?: string): Backend | null {
        const healthy = this.backends.filter(b => b.healthy !== false);
        if (healthy.length === 0) return null;

        const ip = clientIp || '127.0.0.1';
        const hash = this.hashCode(ip);
        const index = Math.abs(hash) % healthy.length;

        return healthy[index];
    }

    /**
     * Simple hash function for strings.
     * Same input → same output (deterministic).
     */
    private hashCode(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash;
    }

    updateBackends(backends: Backend[]): void {
        this.backends = backends;
    }
}