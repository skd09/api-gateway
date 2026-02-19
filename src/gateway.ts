import express, { Request, Response } from 'express';
import http from 'http';
import { RateLimiter } from './rate-limiters/types';
import { FixedWindowRateLimiter } from './rate-limiters/fixed-window';
import { SlidingLogRateLimiter } from './rate-limiters/sliding-log';
import { SlidingCounterRateLimiter } from './rate-limiters/sliding-counter';
import { TokenBucketRateLimiter } from './rate-limiters/token-bucket';
import { LeakyBucketRateLimiter } from './rate-limiters/leaky-bucket';

// =================================================================
// LAYER 2: API GATEWAY WITH RATE LIMITING
// =================================================================

const app = express();

const BACKEND = {
  host: 'localhost',
  port: 3001,
};

// ── Rate Limiters — all 5 available, switch via query param ─────

const rateLimiters: Record<string, RateLimiter> = {
    'fixed-window':    new FixedWindowRateLimiter(10, 60000), // 10 req/min
    'sliding-log':     new SlidingLogRateLimiter(10, 60000),
    'sliding-counter': new SlidingCounterRateLimiter(10, 60000),
    'token-bucket':    new TokenBucketRateLimiter(10, 2), // 10 capacity, 2/sec refill
    'leaky-bucket':    new LeakyBucketRateLimiter(10, 2), // 10 capacity, 2/sec leak
};

// Default algorithm
let activeAlgorithm = 'sliding-counter';

// ── Proxy Function ──────────────────────────────────────────────

function proxyRequest(clientReq: Request, clientRes: Response): void {
    const startTime = Date.now();

    const options: http.RequestOptions = {
        hostname: BACKEND.host,
        port: BACKEND.port,
        path: clientReq.originalUrl,
        method: clientReq.method,
        headers: {
            ...clientReq.headers,
            host: `${BACKEND.host}:${BACKEND.port}`,
        },
    };

    const backendReq = http.request(options, (backendRes) => {
        const elapsed = Date.now() - startTime;

        clientRes.setHeader('x-gateway', 'api-gateway-v2');
        clientRes.setHeader('x-backend-port', String(BACKEND.port));
        clientRes.setHeader('x-response-time', `${elapsed}ms`);

        clientRes.writeHead(backendRes.statusCode || 500, backendRes.headers);
        backendRes.pipe(clientRes);

        console.log(
            ` ${clientReq.method} ${clientReq.originalUrl} → Backend:${BACKEND.port} [${backendRes.statusCode}] ${elapsed}ms`
        );
    });

    backendReq.on('error', (err) => {
        console.error(`Backend error: ${err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
                error: 'Bad Gateway',
                message: 'Backend server is unavailable',
            }));
        }
    });

    clientReq.pipe(backendReq);
}

// ── Gateway Management Endpoints ────────────────────────────────

app.get('/gateway/health', (req, res) => {
    res.json({
        status: 'ok',
        layer: 'Layer 2: Rate Limiting',
        activeAlgorithm,
        availableAlgorithms: Object.keys(rateLimiters),
        backend: `${BACKEND.host}:${BACKEND.port}`,
    });
});

// Switch algorithm at runtime
app.post('/gateway/algorithm/:name', express.json(), (req, res) => {
    const name = req.params.name;

    if (!rateLimiters[name]) {
        res.status(400).json({
            error: `Unknown algorithm: ${name}`,
            available: Object.keys(rateLimiters),
        });
        return;
    }

    activeAlgorithm = name;
    console.log(`Switched rate limiter to: ${name}`);

    res.json({
        status: 'switched',
        algorithm: name,
    });
});

// Compare all algorithms for a given key
app.get('/gateway/compare', async (req, res) => {
    const key = (req.ip || req.query.key || '127.0.0.1') as string;
    const results: Record<string, any> = {};

    for (const [name, limiter] of Object.entries(rateLimiters)) {
        // Peek without consuming — create a test key
        const testKey = `compare:${key}`;
        results[name] = {
            algorithm: name,
            description: getDescription(name),
        };
    }

    res.json({
        activeAlgorithm,
        algorithms: results,
        testEndpoint: 'Run: for i in $(seq 1 15); do curl -s http://localhost:4000/api/users | head -1; done',
    });
});

function getDescription(name: string): string {
    const descriptions: Record<string, string> = {
        'fixed-window':    'Counter per time window. Simple but has boundary burst problem.',
        'sliding-log':     'Stores every timestamp. Perfectly accurate but memory-heavy.',
        'sliding-counter': 'Weighted average of current + previous window. Best balance.',
        'token-bucket':    'Tokens refill at steady rate. Allows bursts. Used by AWS.',
        'leaky-bucket':    'Queue drains at fixed rate. Smooths traffic. Used by Shopify.',
    };
    return descriptions[name] || '';
}

// ── Rate Limited Proxy — All other requests ─────────────────────

app.all('/{*path}', async (req, res) => {
    // Use client IP as the rate limit key
    const clientKey = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    const limiter = rateLimiters[activeAlgorithm];

    // Check rate limit
    const result = await limiter.consume(clientKey);

    // Always set rate limit headers (industry standard)
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Algorithm', limiter.name);

    if (!result.allowed) {
        // 429 Too Many Requests
        res.setHeader('Retry-After', result.retryAfter || 1);

        console.log(
            `RATE LIMITED ${req.method} ${req.originalUrl} [${limiter.name}] ` +
            `key=${clientKey} retry=${result.retryAfter}s`
        );

        res.status(429).json({
            error: 'Too Many Requests',
            algorithm: limiter.name,
            limit: result.limit,
            retryAfter: result.retryAfter,
            message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
        });
        return;
  }

  // Allowed — proxy to backend
  proxyRequest(req, res);
});

// ── Start ───────────────────────────────────────────────────────

const GATEWAY_PORT = 4000;

app.listen(GATEWAY_PORT, () => {
  console.log('');
  console.log('='.repeat(55));
  console.log('  API Gateway — Layer 2: Rate Limiting');
  console.log('='.repeat(55));
  console.log('');
  console.log(`  Gateway: http://localhost:${GATEWAY_PORT}`);
  console.log(`  Backend: http://localhost:${BACKEND.port}`);
  console.log(`  Algorithm:  ${activeAlgorithm}`);
  console.log(`  Limit: 10 requests/minute`);
  console.log('');
  console.log('  Endpoints:');
  console.log('  GET  /gateway/health → status + active algorithm');
  console.log('  POST /gateway/algorithm/:name → switch algorithm');
  console.log('  GET  /gateway/compare → compare all algorithms');
  console.log('  *    /* → rate limited proxy');
  console.log('');
});