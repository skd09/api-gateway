# API Gateway from Scratch

**Production-grade API gateway built from scratch in Node.js/TypeScript — 5 rate limiting algorithms, 5 load balancing algorithms, circuit breaker pattern, and middleware pipeline. Every component implemented from first principles.**

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs" alt="Node.js"></a>
  <a href="https://expressjs.com/"><img src="https://img.shields.io/badge/Express-5.x-000000?logo=express" alt="Express"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?logo=react" alt="React"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## What Is This?

A fully functional API gateway that sits between clients and backend servers, handling rate limiting, load balancing, circuit breaking, and request proxying — all built from scratch with no abstraction libraries. Every algorithm is implemented manually so you can see exactly how production systems like Nginx, Kong, and AWS API Gateway work internally.

Built as a learning project and technical showcase for system design interviews.

### Architecture

```
                                    ┌─────────────────────────────────────────┐
                                    │         Middleware Pipeline             │
                                    │                                         │
Client ──▶ Gateway:4000 ──▶ [Logger] → [CORS] → [Rate Limit] → [Circuit Breaker] → [Proxy]
                                    │      │          │               │            │
                                    │      │          │               │            ├──▶ Backend-A:3001
                                    │      │          │               │            ├──▶ Backend-B:3002
                                    │      │     429 Too Many    503 Circuit     └──▶ Backend-C:3003
                                    │      │     Requests        Open
                                    │   Always                                    │
                                    │   logs                                      │
                                    └─────────────────────────────────────────────┘
                                                                                  │
                                                                          ┌───────┴───────┐
                                                                          │   Dashboard   │
                                                                          │   :5174       │
                                                                          └───────────────┘
```

### Key Features

- **5 rate limiting algorithms** — Fixed Window, Sliding Log, Sliding Counter, Token Bucket, Leaky Bucket
- **5 load balancing algorithms** — Round Robin, Weighted Round Robin, Least Connections, IP Hash, Consistent Hashing
- **Circuit breaker** — 3-state (Closed → Open → Half-Open) with configurable thresholds
- **Middleware pipeline** — composable chain, add/remove/reorder features in one line
- **Live algorithm switching** — change rate limiter or load balancer at runtime via API
- **Backend crash simulation** — make servers return 500s, watch circuit breakers trip and recover
- **React dashboard** — real-time visualization of traffic distribution, circuit states, and burst testing
- **Zero dependencies for core logic** — no Bull, no http-proxy, no rate-limit libraries

---

## Concepts Covered

| Concept | Implementation | File | Interview Relevance |
|---------|---------------|------|-------------------|
| Fixed Window | Counter per time window, resets at boundary | `rate-limiters/fixed-window.ts` | Simplest rate limiter |
| Sliding Window Log | Store every timestamp, count in window | `rate-limiters/sliding-log.ts` | Accuracy vs memory trade-off |
| Sliding Window Counter | Weighted average of 2 windows | `rate-limiters/sliding-counter.ts` | Used by Stripe, Cloudflare |
| Token Bucket | Tokens refill at steady rate, allows bursts | `rate-limiters/token-bucket.ts` | Used by AWS API Gateway |
| Leaky Bucket | Queue drains at fixed rate, smooths traffic | `rate-limiters/leaky-bucket.ts` | Used by Shopify |
| Round Robin | Simple rotation A → B → C | `load-balancers/round-robin.ts` | Every LB question |
| Weighted Round Robin | Proportional to server capacity | `load-balancers/weighted-round-robin.ts` | Mixed hardware scenarios |
| Least Connections | Route to least busy server | `load-balancers/least-connections.ts` | Handles slow servers |
| IP Hash | Same client → same server (sticky sessions) | `load-balancers/ip-hash.ts` | Session affinity |
| Consistent Hashing | Hash ring with virtual nodes | `load-balancers/consistent-hash.ts` | Redis Cluster, DynamoDB |
| Circuit Breaker | 3-state: Closed → Open → Half-Open | `circuit-breaker/circuit-breaker.ts` | Netflix Hystrix pattern |
| Middleware Pipeline | Composable request chain | `middleware/pipeline.ts` | Express/Koa internals |
| Reverse Proxy | Manual HTTP forwarding with `http.request` | `middleware/proxy.ts` | How Nginx works |

---

## Prerequisites

| Tool | Version | Install (macOS) |
|------|---------|-----------------|
| [Node.js](https://nodejs.org/) | >= 20 | `brew install node` |

No Docker required. Everything runs locally.

---

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/api-gateway.git
cd api-gateway
npm install
```

### 2. Start All Services

```bash
# Terminal 1 — 3 backend servers
npm run backend

# Terminal 2 — gateway
npm run dev

# Terminal 3 — dashboard
npx serve frontend/public -l 5174
```

### 3. Access

| Service | URL |
|---------|-----|
| Gateway | http://localhost:4000 |
| Dashboard | http://localhost:5174 |
| Backend-A | http://localhost:3001 |
| Backend-B | http://localhost:3002 |
| Backend-C | http://localhost:3003 |

### 4. Test

```bash
# Request through the gateway
curl http://localhost:4000/api/users | python3 -m json.tool

# Check response headers
curl -v http://localhost:4000/api/users 2>&1 | grep "x-"
# x-gateway: api-gateway-v5
# x-backend: Backend-A
# x-response-time: 45ms
# x-lb-algorithm: round-robin
# x-circuit-state: CLOSED

# Watch load distribution (round robin)
for i in $(seq 1 6); do
  curl -s http://localhost:4000/api/users | python3 -c "import sys,json; print(json.load(sys.stdin)['server'])"
done
# Backend-A → Backend-B → Backend-C → Backend-A → Backend-B → Backend-C
```

### 5. Test Circuit Breaker

```bash
# Crash Backend-A (makes it return 500s)
curl -s -X POST http://localhost:3001/admin/crash

# Send requests — circuit trips after 3 failures
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" http://localhost:4000/api/users
  sleep 0.5
done

# Check circuit states
curl -s http://localhost:4000/gateway/health | python3 -c "
import sys, json
for b in json.load(sys.stdin)['backends']:
    print(f\"{b['name']}: {b['circuitState']}\")
"
# Backend-A: OPEN    ← tripped!
# Backend-B: CLOSED
# Backend-C: CLOSED

# Recover Backend-A
curl -s -X POST http://localhost:3001/admin/crash
# Wait 15s... circuit goes HALF-OPEN → tests → CLOSED
```

### 6. Switch Algorithms at Runtime

```bash
# Switch rate limiter
curl -s -X POST http://localhost:4000/gateway/rate-limiter/token-bucket

# Switch load balancer
curl -s -X POST http://localhost:4000/gateway/load-balancer/weighted-round-robin
```

---

## Project Structure

```
api-gateway/
├── src/
│   ├── gateway.ts                       # Wires the middleware pipeline
│   ├── backends.ts                      # 3 backend servers + crash simulation
│   ├── start-all.ts                     # Starts everything together
│   │
│   ├── middleware/                       # Composable request pipeline
│   │   ├── types.ts                     # GatewayContext + middleware interface
│   │   ├── pipeline.ts                  # Chains middleware in order
│   │   ├── logger.ts                    # Request/response logging
│   │   ├── cors.ts                      # CORS headers + preflight
│   │   ├── rate-limit.ts               # Rate limiter middleware
│   │   ├── circuit-breaker.ts        # Circuit breaker + LB selection
│   │   └── proxy.ts                     # HTTP proxy to backend
│   │
│   ├── rate-limiters/                   # 5 rate limiting algorithms
│   │   ├── types.ts                     # RateLimiter interface
│   │   ├── fixed-window.ts             # Counter per time window
│   │   ├── sliding-log.ts             # Timestamp log (exact)
│   │   ├── sliding-counter.ts         # Weighted window average
│   │   ├── token-bucket.ts            # Refilling tokens (allows bursts)
│   │   └── leaky-bucket.ts            # Fixed-rate drain (smooths traffic)
│   │
│   ├── load-balancers/                  # 5 load balancing algorithms
│   │   ├── types.ts                     # LoadBalancer interface
│   │   ├── round-robin.ts             # Simple rotation
│   │   ├── weighted-round-robin.ts    # Proportional to server weight
│   │   ├── least-connections.ts       # Route to least busy
│   │   ├── ip-hash.ts                # Client IP → same server
│   │   └── consistent-hash.ts        # Hash ring with virtual nodes
│   │
│   └── circuit-breaker/                 # Fail-fast pattern
│       └── circuit-breaker.ts           # 3-state: Closed/Open/Half-Open
│
├── frontend/
│   └── public/
│       └── index.html                   # React dashboard (single file)
│
├── package.json
└── tsconfig.json
```

---

## How It Works

### Request Flow

1. **Client** sends request to gateway (port 4000)
2. **Logger** records the request (always runs, even on rejections)
3. **CORS** adds cross-origin headers
4. **Rate Limiter** checks if client exceeded their limit → 429 if exceeded
5. **Circuit Breaker + Load Balancer** selects a healthy backend → 503 if all circuits open
6. **Proxy** forwards request to selected backend, pipes response back

Each middleware can **short-circuit** the chain. Rate limiter returns 429 without ever reaching the proxy. Circuit breaker returns 503 without attempting a connection to a dead server.

### Failure Handling — Circuit Breaker

```
CLOSED (normal operation)
  │
  │  3 failures within 10 seconds
  ▼
OPEN (fast-fail — reject in 1ms instead of waiting 30s timeout)
  │
  │  wait 15 seconds
  ▼
HALF-OPEN (send 1 test request)
  ├── success → back to CLOSED (backend recovered)
  └── failure → back to OPEN (still dead)
```

### Rate Limiting — 5 Algorithms Compared

| Algorithm | Allows Bursts? | Memory | Accuracy | Used By |
|-----------|---------------|--------|----------|---------|
| Fixed Window | Boundary burst problem | O(1) | Low | Simple APIs |
| Sliding Log | No | O(N) | Perfect | Low-volume APIs |
| Sliding Counter | No | O(1) | High | Stripe, Cloudflare |
| Token Bucket | Yes (up to capacity) | O(1) | High | AWS API Gateway |
| Leaky Bucket | No (smooths traffic) | O(1) | High | Shopify |

### Load Balancing — 5 Algorithms Compared

| Algorithm | Distribution | Sticky? | Handles Slow Servers? |
|-----------|-------------|---------|----------------------|
| Round Robin | Equal | No | No |
| Weighted RR | Proportional to weight | No | Partially |
| Least Connections | By current load | No | Yes |
| IP Hash | By client IP | Yes | No |
| Consistent Hash | By hash ring | Yes | Minimal disruption on failure |

---

## API Reference

### Gateway Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/gateway/health` | Full status: pipeline, algorithms, backends, metrics |
| `POST` | `/gateway/rate-limiter/:name` | Switch rate limiting algorithm at runtime |
| `POST` | `/gateway/load-balancer/:name` | Switch load balancing algorithm at runtime |
| `POST` | `/gateway/backend/:name/toggle` | Toggle backend healthy/down |
| `POST` | `/gateway/circuit/:name/reset` | Reset circuit breaker to CLOSED |
| `POST` | `/gateway/metrics/reset` | Reset all counters |

### Backend Servers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | Sample data (proxied through gateway) |
| `GET` | `/api/health` | Backend health check |
| `POST` | `/admin/crash` | Toggle crash mode (500s with slow response) |

---

## How It Was Built (6 Layers)

Each layer adds one concept on top of the previous. The codebase evolved incrementally.

| Layer | Concept | What Changed |
|-------|---------|-------------|
| **1** | Basic Proxy | Express receives request, `http.request` forwards to backend, pipes response. |
| **2** | Rate Limiting | 5 algorithms. Gateway rejects excess requests with 429. |
| **3** | Load Balancing | 5 algorithms. Traffic distributes across 3 backends. |
| **4** | Circuit Breaker | 3-state pattern. Dead backends get fast-failed, auto-recovery via half-open. |
| **5** | Middleware Pipeline | Refactored into composable chain. Each concern is independent. |
| **6** | Dashboard | React dashboard with live metrics, algorithm switching, burst testing. |

---

## Dashboard

The React dashboard provides live control and visualization:

- **Pipeline visualization** — shows middleware chain: logger → cors → rate-limit → circuit-breaker → proxy
- **System metrics** — total requests, proxied, rate limited, circuit broken, errors
- **Algorithm panels** — click to switch rate limiter or load balancer live
- **Backend servers** — health status, circuit state, traffic distribution bars, toggle/crash/reset buttons
- **Load tester** — burst 10/20/50/100 concurrent requests, see success vs limited vs error
- **Event log** — scrollable log of all dashboard actions

### Demo Scenarios

| Scenario | Steps | What You'll See |
|----------|-------|----------------|
| Load distribution | Reset metrics → round-robin → burst 30 | Even 33/33/33 split |
| Weighted traffic | Switch to weighted-round-robin → burst 30 | A: ~50%, B: ~33%, C: ~17% |
| Circuit breaker | Crash Backend-A → burst 20 | A trips OPEN, traffic shifts to B+C |
| Self-healing | Recover Backend-A → wait 15s | HALF-OPEN → test → CLOSED → A rejoins |
| Rate limiting | Token-bucket → burst 50 | ~20 succeed (burst), rest 429 |
| Total meltdown | Crash all 3 → burst | All circuits OPEN → 503 everywhere |

---

## Related Projects

This is **Project 2** of a 3-project distributed systems portfolio:

| # | Project | Concepts |
|---|---------|----------|
| 1 | [Notification Engine](https://github.com/skd09/notification-engine) | Queues, DLQ, Redis, Pub/Sub, Polling |
| **2** | **API Gateway** (this repo) | Rate Limiting, Load Balancing, Circuit Breaker, Middleware Pipeline |
| 3 | Distributed Task Scheduler | Consistency, Leader Election, Sharding |

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.
