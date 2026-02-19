import express from 'express';
import { MiddlewarePipeline } from './middleware/pipeline';
import { LoggerMiddleware } from './middleware/logger';
import { CorsMiddleware } from './middleware/cors';
import { RateLimitMiddleware } from './middleware/rate-limit';
import { CircuitBreakerMiddleware } from './middleware/circuit-breaker';
import { ProxyMiddleware } from './middleware/proxy';
import { RateLimiter } from './rate-limiters/types';
import { FixedWindowRateLimiter } from './rate-limiters/fixed-window';
import { SlidingLogRateLimiter } from './rate-limiters/sliding-log';
import { SlidingCounterRateLimiter } from './rate-limiters/sliding-counter';
import { TokenBucketRateLimiter } from './rate-limiters/token-bucket';
import { LeakyBucketRateLimiter } from './rate-limiters/leaky-bucket';
import { Backend } from './load-balancers/types';
import { RoundRobinBalancer } from './load-balancers/round-robin';
import { WeightedRoundRobinBalancer } from './load-balancers/weighted-round-robin';
import { LeastConnectionsBalancer } from './load-balancers/least-connections';
import { IpHashBalancer } from './load-balancers/ip-hash';
import { ConsistentHashBalancer } from './load-balancers/consistent-hash';
import { CircuitBreaker } from './circuit-breaker/circuit-breaker';

// =================================================================
// LAYER 5: API GATEWAY — MIDDLEWARE PIPELINE
// =================================================================
//
// Compare this to our Layer 4 gateway.ts:
//   Layer 4: One giant catch-all handler with everything mixed together
//   Layer 5: Clean pipeline — each concern is an independent middleware
//
// Adding a new feature? Add one middleware file, one pipeline.use() call.
// Disabling a feature? Remove one line.
// Reordering? Move one line.
//
// This is the pattern used by Express, Koa, Kong, Nginx, and
// every production API gateway.
// =================================================================

const app = express();

// CORS for dashboard
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});


// ── Configuration ───────────────────────────────────────────────

const backends: Backend[] = [
    { host: 'localhost', port: 3001, name: 'Backend-A', weight: 3, healthy: true },
    { host: 'localhost', port: 3002, name: 'Backend-B', weight: 2, healthy: true },
    { host: 'localhost', port: 3003, name: 'Backend-C', weight: 1, healthy: true },
];

const rateLimiters: Record<string, RateLimiter> = {
    'fixed-window': new FixedWindowRateLimiter(50, 60000),
    'sliding-log': new SlidingLogRateLimiter(50, 60000),
    'sliding-counter': new SlidingCounterRateLimiter(50, 60000),
    'token-bucket': new TokenBucketRateLimiter(20, 5),
    'leaky-bucket': new LeakyBucketRateLimiter(20, 5),
};

const loadBalancers = {
    'round-robin': new RoundRobinBalancer(backends),
    'weighted-round-robin': new WeightedRoundRobinBalancer(backends),
    'least-connections': new LeastConnectionsBalancer(backends),
    'ip-hash': new IpHashBalancer(backends),
    'consistent-hash': new ConsistentHashBalancer(backends),
};

const circuitBreakers: Record<string, CircuitBreaker> = {};
for (const b of backends) {
    circuitBreakers[b.name] = new CircuitBreaker(b.name, {
        failureThreshold: 3,
        resetTimeout: 15000,
        monitorWindow: 10000,
        halfOpenMax: 1,
    });
}

// Active selections
let activeRateLimiter = 'token-bucket';
let activeLoadBalancer = 'round-robin';

const metrics = {
    totalRequests: 0,
    rateLimited: 0,
    circuitBroken: 0,
    proxied: 0,
    byBackend: {} as Record<string, number>,
    errors: 0,
};

// ── Build the Pipeline ──────────────────────────────────────────
//
// This is the ENTIRE request flow in 5 lines:

const pipeline = new MiddlewarePipeline()
    .use(new LoggerMiddleware())
    .use(new CorsMiddleware())
    .use(new RateLimitMiddleware(rateLimiters, () => activeRateLimiter))
    .use(new CircuitBreakerMiddleware(backends, circuitBreakers, loadBalancers, () => activeLoadBalancer))
    .use(new ProxyMiddleware(loadBalancers, () => activeLoadBalancer, metrics));

// ── Gateway Management Endpoints ────────────────────────────────

app.get('/gateway/health', (req, res) => {
    res.json({
        status: 'ok',
        layer: 'Layer 5: Middleware Pipeline',
        pipeline: pipeline.getMiddlewareNames(),
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
        metrics,
    });
});

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

app.post('/gateway/load-balancer/:name', express.json(), (req, res) => {
    const name = req.params.name;
    if (!loadBalancers[name as keyof typeof loadBalancers]) {
        res.status(400).json({ error: `Unknown: ${name}`, available: Object.keys(loadBalancers) });
        return;
    }
    activeLoadBalancer = name;
    console.log(`Load balancer → ${name}`);
    res.json({ status: 'switched', loadBalancer: name });
});

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

app.post('/gateway/metrics/reset', express.json(), (req, res) => {
    metrics.totalRequests = 0;
    metrics.rateLimited = 0;
    metrics.circuitBroken = 0;
    metrics.proxied = 0;
    metrics.byBackend = {};
    metrics.errors = 0;
    res.json({ status: 'reset' });
});

// ── Pipeline handles ALL other requests ─────────────────────────

app.all('/{*path}', async (req, res) => {
    metrics.totalRequests++;
    await pipeline.execute(req, res);
});

// ── Start ───────────────────────────────────────────────────────

const GATEWAY_PORT = 4000;

app.listen(GATEWAY_PORT, () => {
    console.log('');
    console.log('='.repeat(65));
    console.log('API Gateway — Layer 5: Middleware Pipeline');
    console.log('='.repeat(65));
    console.log('');
    console.log(`  Gateway: http://localhost:${GATEWAY_PORT}`);
    console.log(`  Pipeline: ${pipeline.getMiddlewareNames().join(' → ')}`);
    console.log(`  Rate Limiter: ${activeRateLimiter}`);
    console.log(`  Load Balancer: ${activeLoadBalancer}`);
    console.log(`  Backends: ${backends.map(b => `${b.name}:${b.port}`).join(', ')}`);
    console.log('');
    console.log('  Management:');
    console.log('  GET  /gateway/health → full status');
    console.log('  POST /gateway/rate-limiter/:name → switch rate limiter');
    console.log('  POST /gateway/load-balancer/:name → switch LB algorithm');
    console.log('  POST /gateway/backend/:name/toggle → toggle server up/down');
    console.log('  POST /gateway/circuit/:name/reset → reset circuit breaker');
    console.log('  POST /gateway/metrics/reset → reset counters');
    console.log('');
});