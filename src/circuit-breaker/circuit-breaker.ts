// =================================================================
// CIRCUIT BREAKER
// =================================================================
//
// Prevents cascading failures by fast-failing requests to
// unhealthy backends instead of waiting for timeouts.
//
// Real-world: Netflix Hystrix, resilience4j, Polly (.NET)
//
// Configuration:
//   failureThreshold: 5     — trips after 5 failures
//   resetTimeout: 30000     — waits 30s before testing again
//   monitorWindow: 10000    — counts failures within 10s window
//   halfOpenMax: 1          — allows 1 test request in half-open
// =================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
    failureThreshold: number;   // Failures before opening
    resetTimeout: number; // Ms before trying half-open
    monitorWindow: number; // Ms window to count failures
    halfOpenMax: number; // Test requests allowed in half-open
}

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED';
    private failures: number[] = []; // Timestamps of recent failures
    private successes: number = 0;
    private lastFailure: number = 0;
    private openedAt: number = 0;
    private halfOpenAttempts: number = 0;

    // Stats for dashboard
    private stats = {
        totalRequests: 0,
        totalFailures: 0,
        totalRejected: 0, // Rejected while OPEN
        totalSuccesses: 0,
        stateChanges: [] as Array<{ from: CircuitState; to: CircuitState; at: string }>,
    };

    constructor(
        public readonly name: string,
        private options: CircuitBreakerOptions = {
            failureThreshold: 5,
            resetTimeout: 30000,
            monitorWindow: 10000,
            halfOpenMax: 1,
        }
    ) {}

    /**
     * Check if a request should be allowed through.
     */
    canRequest(): boolean {
        this.stats.totalRequests++;

        switch (this.state) {
        case 'CLOSED':
            return true;

        case 'OPEN':
            // Check if enough time has passed to try half-open
            if (Date.now() - this.openedAt >= this.options.resetTimeout) {
                this.transitionTo('HALF_OPEN');
                this.halfOpenAttempts = 0;
                return true; // Allow the test request
            }
            // Still in cooldown — reject immediately
            this.stats.totalRejected++;
            return false;

        case 'HALF_OPEN':
            // Allow limited test requests
            if (this.halfOpenAttempts < this.options.halfOpenMax) {
                this.halfOpenAttempts++;
                return true;
            }
            // Already testing, reject others
            this.stats.totalRejected++;
            return false;
        }
    }

    /**
     * Record a successful request.
     */
    onSuccess(): void {
        this.stats.totalSuccesses++;

        switch (this.state) {
        case 'HALF_OPEN':
            // Test passed! Backend is healthy again.
            this.transitionTo('CLOSED');
            this.failures = [];
            this.successes = 0;
            console.log(`[CB:${this.name}] Test request succeeded → CLOSED`);
            break;

        case 'CLOSED':
            this.successes++;
            break;
        }
    }

    /**
     * Record a failed request.
     */
    onFailure(): void {
        this.stats.totalFailures++;
        const now = Date.now();

        switch (this.state) {
        case 'CLOSED':
            // Add failure timestamp
            this.failures.push(now);

            // Remove failures outside the monitoring window
            this.failures = this.failures.filter(
                t => now - t < this.options.monitorWindow
            );

            // Check if we should trip the circuit
            if (this.failures.length >= this.options.failureThreshold) {
                this.transitionTo('OPEN');
                this.openedAt = now;
                console.log(
                    `[CB:${this.name}] ${this.failures.length} failures in ` +
                    `${this.options.monitorWindow / 1000}s → OPEN ` +
                    `(will retry in ${this.options.resetTimeout / 1000}s)`
                );
            }
            break;

        case 'HALF_OPEN':
            // Test failed! Backend is still down.
            this.transitionTo('OPEN');
            this.openedAt = now;
            console.log(`[CB:${this.name}] Test request failed → back to OPEN`);
            break;
        }
    }

    private transitionTo(newState: CircuitState): void {
        const from = this.state;
        this.state = newState;

        this.stats.stateChanges.push({
            from,
            to: newState,
            at: new Date().toISOString(),
        });

        console.log(` ⚡ [CB:${this.name}] ${from} → ${newState}`);
    }

    getState(): CircuitState {
        // Check if OPEN should transition to HALF_OPEN
        if (this.state === 'OPEN') {
            if (Date.now() - this.openedAt >= this.options.resetTimeout) {
                this.transitionTo('HALF_OPEN');
                this.halfOpenAttempts = 0;
            }
        }
        return this.state;
    }

    getStats() {
        return {
            name: this.name,
            state: this.getState(),
            options: this.options,
            recentFailures: this.failures.length,
            ...this.stats,
            stateChanges: this.stats.stateChanges.slice(-10), // Last 10
        };
    }

    /**
     * Reset — for testing and dashboard
     */
    reset(): void {
        this.state = 'CLOSED';
        this.failures = [];
        this.successes = 0;
        this.halfOpenAttempts = 0;
        this.openedAt = 0;
        this.stats.totalRequests = 0;
        this.stats.totalFailures = 0;
        this.stats.totalRejected = 0;
        this.stats.totalSuccesses = 0;
        this.stats.stateChanges = [];
    }
}