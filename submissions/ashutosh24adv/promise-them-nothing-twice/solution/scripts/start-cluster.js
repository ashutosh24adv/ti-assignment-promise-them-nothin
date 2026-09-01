const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const NODES = [
  { name: 'node1', port: 3001 },
  { name: 'node2', port: 3002 },
  { name: 'node3', port: 3003 },
];

const LB_PORT = parseInt(process.env.LB_PORT || '8080', 10);
const children = [];
let roundRobinIndex = 0;

console.log('=====================================================');
console.log('  Starting RelayAPI 3-Node Cluster & Load Balancer   ');
console.log('=====================================================');

// Spawn each node process
NODES.forEach(({ name, port }) => {
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: {
      ...process.env,
      NODE_NAME: name,
      PORT: String(port),
    },
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error(`[Cluster] Error in ${name}:`, err);
  });

  child.on('exit', (code, signal) => {
    console.log(`[Cluster] ${name} exited with code ${code} signal ${signal}`);
  });

  children.push(child);
});

// Create round-robin load balancer
const lb = http.createServer((req, res) => {
  const targetNode = NODES[roundRobinIndex % NODES.length];
  roundRobinIndex++;

  const options = {
    hostname: '127.0.0.1',
    port: targetNode.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[LoadBalancer] Proxy error forwarding to ${targetNode.name}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad gateway', target: targetNode.name }));
  });

  req.pipe(proxyReq);
});

lb.listen(LB_PORT, '0.0.0.0', () => {
  console.log(`[LoadBalancer] Listening on http://0.0.0.0:${LB_PORT}`);
  console.log(`[LoadBalancer] Routing traffic across: ${NODES.map((n) => `${n.name} (port ${n.port})`).join(', ')}`);
});

const cleanup = () => {
  console.log('\n[Cluster] Shutting down load balancer and child nodes...');
  lb.close();
  children.forEach((child) => child.kill('SIGTERM'));
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
