import express from 'express';

// =================================================================
// BACKEND SERVERS — Simple services the gateway proxies to
// =================================================================
//
// We run 3 identical servers on different ports.
// Each identifies itself so you can see which one handled the request.
//
// In production, these would be separate microservices:
//   Service A: User service
//   Service B: Order service
//   Service C: Payment service
//
// But for learning, identical servers let us focus on
// the gateway behavior (load balancing, failover, etc.)
// =================================================================

function createBackend(port: number, name: string){
    const app = express();
    app.use(express.json());

    // Simulate variable response times
    app.use((req, res, next) => {
        const delay = Math.random() * 200; // 0-200ms
        setTimeout(next, delay);
    });

    app.get('/api/users', (req, res) => {
        res.json({
            server: name,
            port,
            data: [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
                { id: 3, name: 'Charlie' },
            ],
            timestamp: new Date().toISOString(),
        });
    });

    app.get('/api/health', (req, res) => {
        res.json({
            server: name,
            status: 'healthy',
            uptime: process.uptime()
        });
    });

    app.get('/{*path}', (req, res) => {
        res.json({
            server: name,
            port,
            method: req.method,
            query: req.query,
            headers: {
                host: req.headers.host,
                'user-agent': req.headers['user-agent']
            },
            timestamp: new Date().toISOString(),
        });
    });


    app.listen(port, () => {
        console.log(`   ${name} running on http://localhost:${port}`);
    });
    return app;
}

// Start 3 backends
console.log('\n🖥️  Starting backend servers...\n');
createBackend(3001, 'Backend-A');
createBackend(3002, 'Backend-B');
createBackend(3003, 'Backend-C');
console.log('\n   All backends ready.\n');

export { createBackend };