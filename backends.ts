import express from "express";

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