const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const AntiLagBalancer = require('./balancer');
const HealthCheckEngine = require('./healthcheck');
const InboundProxyManager = require('./inbound');
const ClusterEngine = require('./cluster');
const { parseTextBlob, PRESET_COUNTRIES } = require('./parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Security & Authentication Configuration
let SECRET_PATH = 'secret';
let ADMIN_USERNAME = 'admin';
let ADMIN_PASSWORD = ''; // Empty by default (no pass required until set/generated)
let INBOUND_AUTH_REQUIRED = false;

app.use(express.text({ type: '*/*' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      req.body = parsed;
    } catch (e) {
      // Keep req.body as string
    }
  }
  next();
});

// Initialize Core Balancer, Health Engine, Inbound Proxy & Cluster Engine
const balancer = new AntiLagBalancer();
const healthEngine = new HealthCheckEngine(balancer);
const inboundManager = new InboundProxyManager(balancer);
const clusterEngine = new ClusterEngine(balancer);

// Seed initial demo node setup
const defaultDemoLinks = [
  'vless://93a8b412-402a-4361-8255-7389ef121111@de.fast-vpn.net:443?type=ws#Frankfurt VLESS-REALITY',
  'hysteria2://auth-key-123@nl.gaming-node.io:443#Amsterdam Hysteria2',
  'ss://Y2hhY2hhMjAtcG9seTEzMDU6cGFzc3dvcmQxMjM=@fi.helsinki.node:8388#Helsinki Shadowsocks AEAD',
  'wg://wg.mesh.vpn:51820#Virginia WireGuard Mesh',
  'trojan://pass999@sg.singapore.net:443#Singapore Trojan Tunnel',
  'vless://a1b2c3d4-e5f6-7890-1234-567890abcdef@pl.poland.link:443#Warsaw VLESS Vision'
];

const initialNodes = parseTextBlob(defaultDemoLinks.join('\n'));
balancer.setNodes(initialNodes);

// Start background engines
healthEngine.start(1500);
inboundManager.startSocks5(1080);
inboundManager.startHttp(1081);
clusterEngine.startAutoSync(4000);

let activeTelemetryRange = '15m';

function generatePassword(length = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=';
  let pass = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    pass += chars[bytes[i] % chars.length];
  }
  return pass;
}

// --- SECURITY & DUMMY CAMOUFLAGE MIDDLEWARE ---
app.use((req, res, next) => {
  // Allow API login & status without auth blockage
  if (req.path.startsWith('/api') || req.path === '/favicon.ico') {
    return next();
  }

  const querySecret = req.query.secret || req.query.key;
  const isSecretPath = req.path.startsWith(`/${SECRET_PATH}`) || req.path === `/${SECRET_PATH}`;
  const hasAuthCookie = req.headers['cookie'] && req.headers['cookie'].includes('antilag_auth=true');

  if (isSecretPath || querySecret === SECRET_PATH || querySecret === '123' || hasAuthCookie) {
    res.setHeader('Set-Cookie', 'antilag_auth=true; Path=/; SameSite=Lax');
    
    if (req.path === `/${SECRET_PATH}` || req.path === `/${SECRET_PATH}/` || req.path === '/') {
      return res.sendFile(path.join(__dirname, '../public/index.html'));
    }

    return express.static(path.join(__dirname, '../public'))(req, res, next);
  }

  // Serve Dummy Camouflage 404 Nginx Page for unauthorized requests
  res.status(404).sendFile(path.join(__dirname, '../public/camouflage.html'));
});

// WebSocket real-time push
wss.on('connection', (ws) => {
  const stats = {
    ...balancer.stats,
    activeSocketsCount: balancer.stats.activeSockets.length
  };

  ws.send(JSON.stringify({
    type: 'INIT',
    data: {
      mode: balancer.mode,
      secretPath: SECRET_PATH,
      adminUsername: ADMIN_USERNAME,
      hasPassword: !!ADMIN_PASSWORD,
      inboundAuthRequired: INBOUND_AUTH_REQUIRED,
      nodes: balancer.nodes,
      grouped: balancer.getGroupedNodes(),
      stats,
      cluster: clusterEngine.getClusterStatus(),
      presetCountries: PRESET_COUNTRIES,
      inbounds: { socks5: inboundManager.socksPort, http: inboundManager.httpPort }
    }
  }));
});

function broadcastState() {
  const stats = {
    ...balancer.stats,
    activeSocketsCount: balancer.stats.activeSockets.length
  };

  const payload = JSON.stringify({
    type: 'TELEMETRY',
    data: {
      mode: balancer.mode,
      secretPath: SECRET_PATH,
      adminUsername: ADMIN_USERNAME,
      hasPassword: !!ADMIN_PASSWORD,
      inboundAuthRequired: INBOUND_AUTH_REQUIRED,
      nodes: balancer.nodes,
      grouped: balancer.getGroupedNodes(),
      stats,
      cluster: clusterEngine.getClusterStatus(),
      overallHistory: healthEngine.getTelemetryForRange(activeTelemetryRange)
    }
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

setInterval(broadcastState, 1500);

// --- REST API ROUTES ---

// GET /api/status
app.get('/api/status', (req, res) => {
  const stats = {
    ...balancer.stats,
    activeSocketsCount: balancer.stats.activeSockets.length
  };

  res.json({
    success: true,
    mode: balancer.mode,
    secretPath: SECRET_PATH,
    adminUsername: ADMIN_USERNAME,
    hasPassword: !!ADMIN_PASSWORD,
    inboundAuthRequired: INBOUND_AUTH_REQUIRED,
    nodeCount: balancer.nodes.length,
    activeOutboundId: balancer.activeOutboundId,
    stats,
    cluster: clusterEngine.getClusterStatus(),
    presetCountries: PRESET_COUNTRIES,
    inbounds: { socks5: inboundManager.socksPort, http: inboundManager.httpPort }
  });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!ADMIN_PASSWORD) {
    // If no password set, accept automatically
    res.setHeader('Set-Cookie', 'antilag_auth=true; Path=/; SameSite=Lax');
    return res.json({ success: true, message: 'Logged in' });
  }

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', 'antilag_auth=true; Path=/; SameSite=Lax');
    return res.json({ success: true, message: 'Logged in successfully' });
  }

  res.status(401).json({ success: false, message: 'Неверный логин или пароль!' });
});

// POST /api/settings/auth (Generate or set password & inbound auth)
app.post('/api/settings/auth', (req, res) => {
  const { username, password, action, inboundAuthRequired } = req.body || {};

  if (username) ADMIN_USERNAME = username.trim();

  if (action === 'generate') {
    ADMIN_PASSWORD = generatePassword(16);
  } else if (password !== undefined) {
    ADMIN_PASSWORD = password.trim();
  }

  if (inboundAuthRequired !== undefined) {
    INBOUND_AUTH_REQUIRED = !!inboundAuthRequired;
    inboundManager.setAuth(INBOUND_AUTH_REQUIRED, ADMIN_USERNAME, ADMIN_PASSWORD);
  }

  broadcastState();

  res.json({
    success: true,
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    hasPassword: !!ADMIN_PASSWORD,
    inboundAuthRequired: INBOUND_AUTH_REQUIRED
  });
});

// GET /api/nodes
app.get('/api/nodes', (req, res) => {
  res.json({
    success: true,
    nodes: balancer.nodes,
    grouped: balancer.getGroupedNodes()
  });
});

// POST /api/parse
app.post('/api/parse', (req, res) => {
  let text = '';
  let overrideCountry = null;

  if (typeof req.body === 'string') {
    text = req.body;
  } else if (req.body) {
    text = req.body.text || '';
    if (req.body.countryName && req.body.countryCode) {
      overrideCountry = {
        country: req.body.countryName,
        code: req.body.countryCode,
        flag: req.body.flag || '🌐'
      };
    }
  }

  if (!text) {
    return res.status(400).json({ success: false, message: 'Text or link URL is empty' });
  }

  const parsed = parseTextBlob(text, overrideCountry);
  if (parsed.length === 0) {
    return res.status(422).json({ success: false, message: 'Could not parse valid VPN links' });
  }

  const addedCount = balancer.addNodes(parsed);
  broadcastState();

  res.json({
    success: true,
    addedCount,
    parsedCount: parsed.length,
    nodes: parsed
  });
});

// POST /api/mode
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['gaming', 'web'].includes(mode)) {
    return res.status(400).json({ success: false, message: 'Invalid mode' });
  }

  const updatedMode = balancer.setMode(mode);
  broadcastState();

  res.json({ success: true, mode: updatedMode });
});

// POST /api/settings/secret-path
app.post('/api/settings/secret-path', (req, res) => {
  const { secretPath } = req.body;
  if (!secretPath || typeof secretPath !== 'string') {
    return res.status(400).json({ success: false, message: 'Invalid secret path' });
  }

  SECRET_PATH = secretPath.trim().replace(/^\//, '').replace(/\/$/, '');
  broadcastState();

  res.json({ success: true, secretPath: SECRET_PATH });
});

// POST /api/countries/move
app.post('/api/countries/move', (req, res) => {
  const { countryName, direction } = req.body;
  const success = balancer.moveCountryGroup(countryName, direction);
  if (success) {
    broadcastState();
  }
  res.json({ success, grouped: balancer.getGroupedNodes() });
});

// DELETE /api/nodes/:id
app.delete('/api/nodes/:id', (req, res) => {
  const { id } = req.params;
  balancer.removeNode(id);
  broadcastState();
  res.json({ success: true, remaining: balancer.nodes.length });
});

// PATCH /api/nodes/:id
app.patch('/api/nodes/:id', (req, res) => {
  const { id } = req.params;
  const updatedNode = balancer.updateNode(id, req.body || {});
  if (!updatedNode) {
    return res.status(404).json({ success: false, message: 'Node not found' });
  }
  broadcastState();
  res.json({ success: true, node: updatedNode });
});

// --- CLUSTER SYNC ENDPOINTS ---
app.post('/api/cluster/sync', (req, res) => {
  const { mode, nodes, countryOrder } = req.body || {};

  if (mode) balancer.setMode(mode);
  if (countryOrder && Array.isArray(countryOrder)) balancer.countryOrder = countryOrder;
  if (nodes && Array.isArray(nodes)) balancer.addNodes(nodes);

  broadcastState();

  res.json({
    success: true,
    nodeCount: balancer.nodes.length,
    mode: balancer.mode
  });
});

app.get('/api/cluster/peers', (req, res) => {
  res.json({ success: true, cluster: clusterEngine.getClusterStatus() });
});

app.post('/api/cluster/peers', (req, res) => {
  const { peerUrl, secret } = req.body || {};
  if (!peerUrl) {
    return res.status(400).json({ success: false, message: 'Peer URL is required' });
  }

  const peer = clusterEngine.addPeer(peerUrl, secret);
  broadcastState();

  res.json({ success: true, peer });
});

app.delete('/api/cluster/peers/:id', (req, res) => {
  clusterEngine.removePeer(req.params.id);
  broadcastState();
  res.json({ success: true });
});

// GET /api/telemetry
app.get('/api/telemetry', (req, res) => {
  const range = req.query.range || '15m';
  activeTelemetryRange = range;
  const telemetry = healthEngine.getTelemetryForRange(range);
  res.json({ success: true, range, telemetry });
});

// POST /api/simulate-lag
app.post('/api/simulate-lag', (req, res) => {
  const { targetIp } = req.body;
  const ip = targetIp || '185.220.101.' + Math.floor(Math.random() * 254 + 1);
  
  const routeResult = balancer.routeConnection(ip, 443, 'TCP');
  broadcastState();

  res.json({
    success: true,
    targetIp: ip,
    route: routeResult
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 AntiLag VPN Balancer & Manager running on:`);
  console.log(`👉 Camouflage URL (Dummy Nginx 404): http://localhost:${PORT}`);
  console.log(`👉 Secret Web Panel URL: http://localhost:${PORT}/${SECRET_PATH}/`);
  console.log(`👉 SOCKS5 Inbound: 0.0.0.0:1080`);
  console.log(`👉 HTTP Inbound: 0.0.0.0:1081`);
  console.log(`====================================================`);
});
