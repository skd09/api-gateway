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

// =================================================================
// LAYER 3: API GATEWAY — RATE LIMITING + LOAD BALANCING
// =================================================================

const app = express();

// ── Backend Servers ─────────────────────────────────────────────

const backends: Backend[] = [
    { host: 'localhost', port: 3001, name: 'Backend-A', weight: 3, healthy: true },
    { host: 'localhost', port: 3002, name: 'Backend-B', weight: 2, healthy: true },
    { host: 'localhost', port: 3003, name: 'Backend-C', weight: 1, healthy: true },
];

// ── Rate Limiters ───────────────────────────────────────────────

const rateLimiters: Record<string, RateLimiter> = {
    'fixed-window': new FixedWindowRateLimiter(10, 60000),
    'sliding-log': new SlidingLogRateLimiter(10, 60000),
    'sliding-counter': new SlidingCounterRateLimiter(10, 60000),
    'token-bucket': new TokenBucketRateLimiter(10, 2),
    'leaky-bucket': new LeakyBucketRateLimiter(10, 2),
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
    byBackend: {} as Record<string, number>,
    errors: 0,
};

// ── Proxy Function ──────────────────────────────────────────────

function proxyRequest(clientReq: Request, clientRes: Response, backend: Backend): void {
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
    };

    const backendReq = http.request(options, (backendRes) => {
        const elapsed = Date.now() - startTime;

        clientRes.setHeader('x-gateway', 'api-gateway-v3');
        clientRes.setHeader('x-backend', backend.name);
        clientRes.setHeader('x-backend-port', String(backend.port));
        clientRes.setHeader('x-response-time', `${elapsed}ms`);
        clientRes.setHeader('x-lb-algorithm', activeLoadBalancer);

        clientRes.writeHead(backendRes.statusCode || 500, backendRes.headers);
        backendRes.pipe(clientRes);

        // Track metrics
        const key = backend.name;
        metrics.byBackend[key] = (metrics.byBackend[key] || 0) + 1;

        // Notify least-connections that request is done
        const lb = loadBalancers[activeLoadBalancer];
        if (lb.onRequestComplete) {
            lb.onRequestComplete(backend);
        }

        console.log(
            `${clientReq.method} ${clientReq.originalUrl} → ${backend.name}:${backend.port} [${backendRes.statusCode}] ${elapsed}ms`
        );
    });

    backendReq.on('error', (err) => {
        metrics.errors++;

        const lb = loadBalancers[activeLoadBalancer];
        if (lb.onRequestComplete) {
        lb.onRequestComplete(backend);
        }

        console.error(`❌ ${backend.name} error: ${err.message}`);

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

// ── Gateway Management Endpoints ────────────────────────────────

app.get('/gateway/health', (req, res) => {
    res.json({
        status: 'ok',
        layer: 'Layer 3: Rate Limiting + Load Balancing',
        rateLimiter: activeRateLimiter,
        loadBalancer: activeLoadBalancer,
        backends: backends.map(b => ({
        name: b.name,
        port: b.port,
        weight: b.weight,
        healthy: b.healthy,
        requests: metrics.byBackend[b.name] || 0,
        })),
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

// Toggle backend health (simulate server going down)
app.post('/gateway/backend/:name/toggle', express.json(), (req, res) => {
    const backend = backends.find(b => b.name === req.params.name);
    if (!backend) {
        res.status(404).json({ error: 'Backend not found' });
        return;
    }

    backend.healthy = !backend.healthy;

    // Update all load balancers
    for (const lb of Object.values(loadBalancers)) {
        if (lb.updateBackends) lb.updateBackends(backends);
    }

    console.log(`${backend.healthy ? '✅' : '❌'} ${backend.name} is now ${backend.healthy ? 'HEALTHY' : 'DOWN'}`);

    res.json({
        backend: backend.name,
        healthy: backend.healthy,
    });
});

// Reset metrics
app.post('/gateway/metrics/reset', express.json(), (req, res) => {
    metrics.totalRequests = 0;
    metrics.rateLimited = 0;
    metrics.byBackend = {};
    metrics.errors = 0;
    res.json({ status: 'reset' });
});

// ── Rate Limited + Load Balanced Proxy ──────────────────────────

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

        console.log(`🚫 RATE LIMITED [${limiter.name}]`);

        res.status(429).json({
            error: 'Too Many Requests',
            algorithm: limiter.name,
            retryAfter: rateResult.retryAfter,
        });
        return;
    }

    // 2. Load Balancing — pick a backend
    const lb = loadBalancers[activeLoadBalancer];
    const backend = lb.select(clientKey);

    if (!backend) {
        console.error('No healthy backends available');
        res.status(503).json({
            error: 'Service Unavailable',
            message: 'No healthy backend servers',
        });
        return;
    }

    // 3. Proxy to selected backend
    proxyRequest(req, res, backend);
});

// ── Start ───────────────────────────────────────────────────────

const GATEWAY_PORT = 4000;

app.listen(GATEWAY_PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('API Gateway — Layer 3: Rate Limiting + Load Balancing');
    console.log('='.repeat(60));
    console.log('');
    console.log(`  Gateway: http://localhost:${GATEWAY_PORT}`);
    console.log(`  Rate Limiter: ${activeRateLimiter}`);
    console.log(`  Load Balancer: ${activeLoadBalancer}`);
    console.log(`  Backends: ${backends.map(b => `${b.name}:${b.port}`).join(', ')}`);
    console.log('');
    console.log('  Management:');
    console.log('  GET  /gateway/health → status + metrics');
    console.log('  POST /gateway/rate-limiter/:name → switch rate limiter');
    console.log('  POST /gateway/load-balancer/:name → switch load balancer');
    console.log('  POST /gateway/backend/:name/toggle → toggle server health');
    console.log('  POST /gateway/metrics/reset → reset counters');
    console.log('');
});