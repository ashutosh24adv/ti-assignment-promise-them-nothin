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
    console.error('[Cluster] Error in %s:', name, err);
  });

  child.on('exit', (code, signal) => {
    console.log('[Cluster] %s exited with code %s signal %s', name, code, signal);
  });

  children.push(child);
});

// Local prototype reverse proxy routing unencrypted HTTP traffic across localhost app nodes
const lb = http.createServer((req, res) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
  const targetNode = NODES[roundRobinIndex % NODES.length];
  roundRobinIndex++;

  const options = { // nosemgrep: problem-based-packs.insecure-transport.js-node.http-request.http-request, problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
    hostname: '127.0.0.1',
    port: targetNode.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  // Local prototype internal proxy request to 127.0.0.1 app nodes over HTTP
  const proxyReq = http.request(options, (proxyRes) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.http-request.http-request, problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[LoadBalancer] Proxy error forwarding to %s:', targetNode.name, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad gateway', target: targetNode.name }));
  });

  req.pipe(proxyReq);
});

lb.listen(LB_PORT, '0.0.0.0', () => {
  console.log('[LoadBalancer] Listening on http://0.0.0.0:%d', LB_PORT);
  console.log('[LoadBalancer] Routing traffic across: %s', NODES.map((n) => n.name + ' (port ' + n.port + ')').join(', '));
});

const cleanup = () => {
  console.log('\n[Cluster] Shutting down load balancer and child nodes...');
  lb.close();
  children.forEach((child) => child.kill('SIGTERM'));
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
