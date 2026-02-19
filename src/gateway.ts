import express, { Request, Response } from 'express';
import http from 'http';

const app = express();

// DON'T use express.json() globally — it consumes the body stream
// We need the raw stream for proxying

const BACKEND = {
  host: 'localhost',
  port: 3001,
};

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

    // Set gateway headers first
    clientRes.setHeader('x-gateway', 'api-gateway-v1');
    clientRes.setHeader('x-backend-port', String(BACKEND.port));
    clientRes.setHeader('x-response-time', `${elapsed}ms`);

    // Write the backend's status code and headers
    clientRes.writeHead(backendRes.statusCode || 500, backendRes.headers);

    // Pipe backend response to client
    backendRes.pipe(clientRes);

    console.log(
      `${clientReq.method} ${clientReq.originalUrl} → Backend:${BACKEND.port} [${backendRes.statusCode}] ${elapsed}ms`
    );
  });

  backendReq.on('error', (err) => {
    console.error(`❌ Backend error: ${err.message}`);

    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        error: 'Bad Gateway',
        message: 'Backend server is unavailable',
      }));
    }
  });

  // Pipe the client's request body to the backend
  clientReq.pipe(backendReq);
}

// Gateway health (not proxied)
app.get('/gateway/health', (req, res) => {
  res.json({
    status: 'ok',
    layer: 'Layer 1: Basic Proxy',
    backend: `${BACKEND.host}:${BACKEND.port}`,
  });
});

// Everything else gets proxied
app.all('/{*path}', (req, res) => {
  proxyRequest(req, res);
});

const GATEWAY_PORT = 4000;

app.listen(GATEWAY_PORT, () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('  🚪 API Gateway — Layer 1: Basic Proxy');
  console.log('='.repeat(50));
  console.log(`  Gateway:  http://localhost:${GATEWAY_PORT}`);
  console.log(`  Backend:  http://localhost:${BACKEND.port}`);
  console.log('');
});