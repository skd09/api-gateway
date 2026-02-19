import express, { Request, Response } from 'express';
import http from 'http';
import { RateLimiter } from './rate-limiters/types';
import { FixedWindowRateLimiter } from './rate-limiters/fixed-window';
import { SlidingLogRateLimiter } from './rate-limiters/sliding-log';
import { SlidingCounterRateLimiter } from './rate-limiters/sliding-counter';
import { TokenBucketRateLimiter } from './rate-limiters/token-bucket';
import { LeakyBucketRateLimiter } from './rate-limiters/leaky-bucket';
import { LoadBalancer, Backend } from './load-balancers/types';
import { RoundRobinBalancer } from './load-balancers/round-robin';
import { WeightedRoundRobinBalancer } from './load-balancers/weighted-round-robin';
import { LeastConnectionsBalancer } from './load-balancers/least-connections';
import { IpHashBalancer } from './load-balancers/ip-hash';
import { ConsistentHashBalancer } from './load-balancers/consistent-hash';
import { CircuitBreaker } from './circuit-breaker/circuit-breaker';

// =================================================================
// LAYER 4: API GATEWAY — RATE LIMIT + LOAD BALANCE + CIRCUIT BREAKER
// =================================================================

const app = express();

// ── Backend Servers ─────────────────────────────────────────────

const backends: Backend[] = [
    { host: 'localhost', port: 3001, name: 'Backend-A', weight: 3, healthy: true },
    { host: 'localhost', port: 3002, name: 'Backend-B', weight: 2, healthy: true },
    { host: 'localhost', port: 3003, name: 'Backend-C', weight: 1, healthy: true },
];

// ── Circuit Breakers — one PER backend ──────────────────────────
//
// Each backend gets its own circuit breaker.
// If Backend-A is failing, its circuit opens.
// Backend-B and C continue serving traffic normally.

const circuitBreakers: Record<string, CircuitBreaker> = {};

for (const backend of backends) {
    circuitBreakers[backend.name] = new CircuitBreaker(backend.name, {
        failureThreshold: 3, // 3 failures to trip
        resetTimeout: 15000, // 15s before testing (short for demo)
        monitorWindow: 10000, // Count failures in last 10s
        halfOpenMax: 1, // 1 test request
    });
}

// ── Rate Limiters ───────────────────────────────────────────────

const rateLimiters: Record<string, RateLimiter> = {
    'fixed-window': new FixedWindowRateLimiter(50, 60000),
    'sliding-log': new SlidingLogRateLimiter(50, 60000),
    'sliding-counter': new SlidingCounterRateLimiter(50, 60000),
    'token-bucket': new TokenBucketRateLimiter(20, 5),
    'leaky-bucket': new LeakyBucketRateLimiter(20, 5),
};

let activeRateLimiter = 'token-bucket';

// ── Load Balancers ──────────────────────────────────────────────

const loadBalancers: Record<string, LoadBalancer> = {
    'round-robin': new RoundRobinBalancer(backends),
    'weighted-round-robin': new WeightedRoundRobinBalancer(backends),
    'least-connections': new LeastConnectionsBalancer(backends),
    'ip-hash': new IpHashBalancer(backends),
    'consistent-hash': new ConsistentHashBalancer(backends),
};

let activeLoadBalancer = 'round-robin';

// ── Metrics ─────────────────────────────────────────────────────

const metrics = {
    totalRequests: 0,
    rateLimited: 0,
    circuitBroken: 0,
    proxied: 0,
    byBackend: {} as Record<string, number>,
    errors: 0,
};

// ── Proxy Function ──────────────────────────────────────────────

function proxyRequest(
    clientReq: Request,
    clientRes: Response,
    backend: Backend,
    cb: CircuitBreaker
): void {
    const startTime = Date.now();

    const options: http.RequestOptions = {
        hostname: backend.host,
        port: backend.port,
        path: clientReq.originalUrl,
        method: clientReq.method,
        headers: {
        ...clientReq.headers,
        host: `${backend.host}:${backend.port}`,
        },
        timeout: 5000, // 5s timeout — don't hang forever
    };

    const backendReq = http.request(options, (backendRes) => {
        const elapsed = Date.now() - startTime;

        // Backend responded — check if it's a server error
        if (backendRes.statusCode && backendRes.statusCode >= 500) {
            cb.onFailure();
        } else {
            cb.onSuccess();
        }

        clientRes.setHeader('x-gateway', 'api-gateway-v4');
        clientRes.setHeader('x-backend', backend.name);
        clientRes.setHeader('x-backend-port', String(backend.port));
        clientRes.setHeader('x-response-time', `${elapsed}ms`);
        clientRes.setHeader('x-lb-algorithm', activeLoadBalancer);
        clientRes.setHeader('x-circuit-state', cb.getState());

        clientRes.writeHead(backendRes.statusCode || 500, backendRes.headers);
        backendRes.pipe(clientRes);

        metrics.proxied++;
        const key = backend.name;
        metrics.byBackend[key] = (metrics.byBackend[key] || 0) + 1;

        const lb = loadBalancers[activeLoadBalancer];
        if (lb.onRequestComplete) lb.onRequestComplete(backend);

        console.log(
            `${clientReq.method} ${clientReq.originalUrl} → ${backend.name} [${backendRes.statusCode}] ${elapsed}ms`
        );
    });

    // Timeout — treat as failure
    backendReq.on('timeout', () => {
        backendReq.destroy();
        cb.onFailure();

        const lb = loadBalancers[activeLoadBalancer];
        if (lb.onRequestComplete) lb.onRequestComplete(backend);

        console.error(`${backend.name} TIMEOUT`);

        if (!clientRes.headersSent) {
            clientRes.writeHead(504, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
                error: 'Gateway Timeout',
                message: `${backend.name} did not respond in time`,
            }));
        }
    });

    backendReq.on('error', (err) => {
        metrics.errors++;
        cb.onFailure();

        const lb = loadBalancers[activeLoadBalancer];
        if (lb.onRequestComplete) lb.onRequestComplete(backend);

        console.error(`${backend.name} error: ${err.message}`);

        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
                error: 'Bad Gateway',
                message: `${backend.name} is unavailable`,
            }));
        }
    });

    clientReq.pipe(backendReq);
}

// ── Select backend with circuit breaker awareness ───────────────

function selectBackend(clientKey: string): { backend: Backend; cb: CircuitBreaker } | null {
    const lb = loadBalancers[activeLoadBalancer];

    // Try up to N times to find a backend with a non-open circuit
    for (let attempt = 0; attempt < backends.length; attempt++) {
        const backend = lb.select(clientKey);
        if (!backend) return null;

        const cb = circuitBreakers[backend.name];

        if (cb.canRequest()) {
            return { backend, cb };
        }

        console.log(`Skipping ${backend.name} (circuit ${cb.getState()})`);

        // Mark this backend as temporarily unavailable for selection
        // For round-robin, just calling select again advances the pointer
    }

    return null;
}

// ── Gateway Management Endpoints ────────────────────────────────

app.get('/gateway/health', (req, res) => {
    res.json({
        status: 'ok',
        layer: 'Layer 4: Rate Limit + Load Balance + Circuit Breaker',
        rateLimiter: activeRateLimiter,
        loadBalancer: activeLoadBalancer,
        backends: backends.map(b => ({
            name: b.name,
            port: b.port,
            weight: b.weight,
            healthy: b.healthy,
            circuitState: circuitBreakers[b.name].getState(),
            requests: metrics.byBackend[b.name] || 0,
        })),
        circuitBreakers: Object.fromEntries(
            Object.entries(circuitBreakers).map(([k, v]) => [k, v.getStats()])
        ),
        metrics,
    });
});

// Switch rate limiter
app.post('/gateway/rate-limiter/:name', express.json(), (req, res) => {
    const name = req.params.name;
    if (!rateLimiters[name]) {
        res.status(400).json({ error: `Unknown: ${name}`, available: Object.keys(rateLimiters) });
        return;
    }
    activeRateLimiter = name;
    console.log(`Rate limiter → ${name}`);
    res.json({ status: 'switched', rateLimiter: name });
});

// Switch load balancer
app.post('/gateway/load-balancer/:name', express.json(), (req, res) => {
    const name = req.params.name;
    if (!loadBalancers[name]) {
        res.status(400).json({ error: `Unknown: ${name}`, available: Object.keys(loadBalancers) });
        return;
    }
    activeLoadBalancer = name;
    console.log(`Load balancer → ${name}`);
    res.json({ status: 'switched', loadBalancer: name });
});

// Toggle backend health
app.post('/gateway/backend/:name/toggle', express.json(), (req, res) => {
    const backend = backends.find(b => b.name === req.params.name);
    if (!backend) {
        res.status(404).json({ error: 'Backend not found' });
        return;
    }

    backend.healthy = !backend.healthy;

    for (const lb of Object.values(loadBalancers)) {
        if (lb.updateBackends) lb.updateBackends(backends);
    }

    console.log(`${backend.healthy ? '✅' : '❌'} ${backend.name} → ${backend.healthy ? 'HEALTHY' : 'DOWN'}`);
    res.json({ backend: backend.name, healthy: backend.healthy });
});

// Reset circuit breaker for a backend
app.post('/gateway/circuit/:name/reset', express.json(), (req, res) => {
    const cb = circuitBreakers[req.params.name];
    if (!cb) {
        res.status(404).json({ error: 'Backend not found' });
        return;
    }

    cb.reset();
    console.log(`Circuit breaker reset: ${req.params.name}`);
    res.json({ backend: req.params.name, state: cb.getState() });
});

// Reset all metrics
app.post('/gateway/metrics/reset', express.json(), (req, res) => {
    metrics.totalRequests = 0;
    metrics.rateLimited = 0;
    metrics.circuitBroken = 0;
    metrics.proxied = 0;
    metrics.byBackend = {};
    metrics.errors = 0;
    res.json({ status: 'reset' });
});

// ── Rate Limited + Load Balanced + Circuit Broken Proxy ─────────

app.all('/{*path}', async (req, res) => {
    metrics.totalRequests++;

    // 1. Rate Limiting
    const clientKey = req.ip || 'unknown';
    const limiter = rateLimiters[activeRateLimiter];
    const rateResult = await limiter.consume(clientKey);

    res.setHeader('X-RateLimit-Limit', rateResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
    res.setHeader('X-RateLimit-Algorithm', limiter.name);

    if (!rateResult.allowed) {
        metrics.rateLimited++;
        res.setHeader('Retry-After', rateResult.retryAfter || 1);
        console.log(`RATE LIMITED [${limiter.name}]`);
        res.status(429).json({
            error: 'Too Many Requests',
            retryAfter: rateResult.retryAfter,
        });
        return;
    }

    // 2. Load Balance + Circuit Breaker
    const selected = selectBackend(clientKey);

    if (!selected) {
        metrics.circuitBroken++;
        console.log(`ALL CIRCUITS OPEN — no backends available`);
        res.status(503).json({
            error: 'Service Unavailable',
            message: 'All backend circuits are open. System is recovering.',
            circuits: Object.fromEntries(
                Object.entries(circuitBreakers).map(([k, v]) => [k, v.getState()])
            ),
        });
        return;
    }

    // 3. Proxy
    proxyRequest(req, res, selected.backend, selected.cb);
});

// ── Start ───────────────────────────────────────────────────────

const GATEWAY_PORT = 4000;

app.listen(GATEWAY_PORT, () => {
    console.log('');
    console.log('='.repeat(65));
    console.log('API Gateway — Layer 4: Rate Limit + Load Balance + Circuit Breaker');
    console.log('='.repeat(65));
    console.log('');
    console.log(`  Gateway: http://localhost:${GATEWAY_PORT}`);
    console.log(`  Rate Limiter: ${activeRateLimiter}`);
    console.log(`  Load Balancer: ${activeLoadBalancer}`);
    console.log(`  Backends: ${backends.map(b => `${b.name}:${b.port}`).join(', ')}`);
    console.log(`  Circuit: 3 failures in 10s → OPEN for 15s`);
    console.log('');
    console.log('  Management:');
    console.log('  GET  /gateway/health  → full status');
    console.log('  POST /gateway/rate-limiter/:name → switch rate limiter');
    console.log('  POST /gateway/load-balancer/:name → switch LB algorithm');
    console.log('  POST /gateway/backend/:name/toggle → toggle server up/down');
    console.log('  POST /gateway/circuit/:name/reset  → reset circuit breaker');
    console.log('  POST /gateway/metrics/reset → reset counters');
    console.log('');
});