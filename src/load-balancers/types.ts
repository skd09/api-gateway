export interface Backend {
    host: string;
    port: number;
    name: string;
    weight?: number; // For weighted round robin
    healthy?: boolean; // For health checking (Layer 4)
}

export interface LoadBalancer {
    /** Pick the next backend server for this request */
    select(clientIp?: string): Backend | null;

    /** Track when a request completes (for least-connections) */
    onRequestComplete? (backend: Backend): void;

    /** Update the list of healthy backends */
    updateBackends? (backends: Backend[]): void;

    /** Algorithm name */
    name: string;
}