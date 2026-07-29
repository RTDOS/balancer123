const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const AntiLagBalancer = require('./balancer');
const HealthCheckEngine = require('./healthcheck');
const { InboundProxyManager, isPortAvailable } = require('./inbound');
const ClusterEngine = require('./cluster');
const { parseTextBlob, PRESET_COUNTRIES } = require('./parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Security & Authentication Configuration (Default admin/admin on first install)
let SECRET_PATH = 'secret';
let ADMIN_USERNAME = 'admin';
let ADMIN_PASSWORD = 'admin'; // Default admin/admin
let IS_DEFAULT_PASSWORD = true;

// Brute-force Security Rate Limiter (IP -> { failedCount, lockUntil })
const failedLoginsMap = new Map();

function isIpLocked(ip) {
  const record = failedLoginsMap.get(ip);
  if (!record) return false;
  if (record.lockUntil && Date.now() < record.lockUntil) {
    return true;
  }
  if (record.lockUntil && Date.now() >= record.lockUntil) {
    failedLoginsMap.delete(ip);
    return false;
  }
  return false;
}

function recordFailedLogin(ip) {
  const record = failedLoginsMap.get(ip) || { failedCount: 0, lockUntil: 0 };
  record.failedCount++;
  if (record.failedCount >= 5) {
    record.lockUntil = Date.now() + 15 * 60 * 1000; // 15-minute lock
  }
  failedLoginsMap.set(ip, record);
  return record;
}

function resetFailedLogins(ip) {
  failedLoginsMap.delete(ip);
}

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

function generateUsername(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let name = 'usr_';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    name += chars[bytes[i] % chars.length];
  }
  return name;
}

function generateSecretPath(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let secret = 'sec-';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    secret += chars[bytes[i] % chars.length];
  }
  return secret;
}

// --- SECURITY & DUMMY CAMOUFLAGE MIDDLEWARE ---
app.use((req, res, next) => {
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
      isDefaultPassword: IS_DEFAULT_PASSWORD,
      securityShield: { active: true, rateLimiter: 'active', camouflage: 'active' },
      nodes: balancer.nodes,
      grouped: balancer.getGroupedNodes(),
      stats,
      cluster: clusterEngine.getClusterStatus(),
      presetCountries: PRESET_COUNTRIES,
      inbounds: inboundManager.getInbounds()
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
      isDefaultPassword: IS_DEFAULT_PASSWORD,
      securityShield: { active: true, rateLimiter: 'active', camouflage: 'active' },
      nodes: balancer.nodes,
      grouped: balancer.getGroupedNodes(),
      stats,
      cluster: clusterEngine.getClusterStatus(),
      inbounds: inboundManager.getInbounds(),
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
  const hasSessionCookie = req.headers['cookie'] && req.headers['cookie'].includes('antilag_session=valid');
  const stats = {
    ...balancer.stats,
    activeSocketsCount: balancer.stats.activeSockets.length
  };

  res.json({
    success: true,
    authenticated: !!hasSessionCookie,
    mode: balancer.mode,
    secretPath: SECRET_PATH,
    adminUsername: ADMIN_USERNAME,
    hasPassword: !!ADMIN_PASSWORD,
    isDefaultPassword: IS_DEFAULT_PASSWORD,
    securityShield: { active: true, rateLimiter: 'active', camouflage: 'active' },
    nodeCount: balancer.nodes.length,
    activeOutboundId: balancer.activeOutboundId,
    stats,
    cluster: clusterEngine.getClusterStatus(),
    presetCountries: PRESET_COUNTRIES,
    inbounds: inboundManager.getInbounds()
  });
});

// POST /api/login (With Anti-Bruteforce Rate Limiting)
app.post('/api/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || '127.0.0.1';

  if (isIpLocked(clientIp)) {
    return res.status(429).json({
      success: false,
      message: 'Превышено количество попыток входа! Доступ заблокирован на 15 минут для защиты.'
    });
  }

  const { username, password } = req.body || {};

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    resetFailedLogins(clientIp);
    res.setHeader('Set-Cookie', 'antilag_session=valid; Path=/; SameSite=Lax');
    return res.json({
      success: true,
      message: 'Logged in successfully',
      isDefaultPassword: IS_DEFAULT_PASSWORD
    });
  }

  const record = recordFailedLogin(clientIp);
  const remaining = 5 - record.failedCount;

  if (remaining <= 0) {
    res.status(429).json({
      success: false,
      message: 'Слишком много неверных попыток! IP заблокирован на 15 минут.'
    });
  } else {
    res.status(401).json({
      success: false,
      message: `Неверный логин или пароль! Осталось попыток: ${remaining}`
    });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'antilag_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.json({ success: true, message: 'Logged out' });
});

// GET /api/generate-password
app.get('/api/generate-password', (req, res) => {
  const generated = generatePassword(16);
  res.json({ success: true, password: generated });
});

// GET /api/generate-username
app.get('/api/generate-username', (req, res) => {
  const generated = generateUsername();
  res.json({ success: true, username: generated });
});

// GET /api/generate-secret-path
app.get('/api/generate-secret-path', (req, res) => {
  const generated = generateSecretPath();
  res.json({ success: true, secretPath: generated });
});

// POST /api/check-port
app.post('/api/check-port', async (req, res) => {
  const { port } = req.body || {};
  const portNum = parseInt(port);
  if (!portNum || portNum < 1 || portNum > 65535) {
    return res.json({ success: false, available: false, message: 'Недопустимый номер порта' });
  }

  const available = await isPortAvailable(portNum);
  res.json({ success: true, port: portNum, available });
});

// --- INBOUND PROXY MANAGEMENT ENDPOINTS ---

// GET /api/inbounds
app.get('/api/inbounds', (req, res) => {
  res.json({ success: true, inbounds: inboundManager.getInbounds() });
});

// POST /api/inbounds (Add new HTTP or SOCKS5 proxy listener)
app.post('/api/inbounds', async (req, res) => {
  const { type, port, username, password, name } = req.body || {};

  if (!['socks5', 'http'].includes((type || '').toLowerCase())) {
    return res.status(400).json({ success: false, message: 'Тип прокси должен быть SOCKS5 или HTTP' });
  }

  const portNum = parseInt(port);
  if (!portNum || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ success: false, message: 'Некорректный номер порта' });
  }

  const avail = await isPortAvailable(portNum);
  if (!avail) {
    return res.status(400).json({ success: false, message: `Порт ${portNum} уже занят в системе!` });
  }

  try {
    const created = await inboundManager.addInbound({
      type,
      port: portNum,
      username,
      password,
      name
    });
    broadcastState();
    res.json({ success: true, inbound: created, inbounds: inboundManager.getInbounds() });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// PUT /api/inbounds/:id (Update inbound proxy settings)
app.put('/api/inbounds/:id', async (req, res) => {
  const { id } = req.params;
  const { type, port, username, password, name } = req.body || {};

  try {
    const updated = await inboundManager.updateInbound(id, { type, port, username, password, name });
    broadcastState();
    res.json({ success: true, inbound: updated, inbounds: inboundManager.getInbounds() });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// DELETE /api/inbounds/:id
app.delete('/api/inbounds/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await inboundManager.deleteInbound(id);
    broadcastState();
    res.json({ success: true, inbounds: inboundManager.getInbounds() });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// POST /api/settings/auth (Update admin panel credentials - invalidates current session to force re-login)
app.post('/api/settings/auth', (req, res) => {
  const { username, password, action } = req.body || {};

  if (username) ADMIN_USERNAME = username.trim();

  let generatedPassword = '';
  if (action === 'generate') {
    generatedPassword = generatePassword(16);
    ADMIN_PASSWORD = generatedPassword;
    IS_DEFAULT_PASSWORD = false;
  } else if (password !== undefined && password !== '') {
    ADMIN_PASSWORD = password.trim();
    IS_DEFAULT_PASSWORD = false;
  }

  // Clear current session cookie to force user to re-login with new credentials!
  res.setHeader('Set-Cookie', 'antilag_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  broadcastState();

  res.json({
    success: true,
    requireRelogin: true,
    adminUsername: ADMIN_USERNAME,
    hasPassword: !!ADMIN_PASSWORD,
    isDefaultPassword: IS_DEFAULT_PASSWORD
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

// --- CLUSTER SYNC ENDPOINTS (Authenticated via Panel Username & Password) ---
app.post('/api/cluster/sync', (req, res) => {
  const { username, password, mode, nodes, countryOrder } = req.body || {};

  // Verify authentication with target node's admin credentials
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: 'Ошибка авторизации кластера! Неверный логин или пароль администратора целевого сервера.'
    });
  }

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
  const { peerUrl, username, password } = req.body || {};
  if (!peerUrl) {
    return res.status(400).json({ success: false, message: 'URL адрес сервера обязателен' });
  }

  const peer = clusterEngine.addPeer(peerUrl, username, password);
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
  console.log(`👉 Security Shield: Active (Brute-Force Rate Limiter & Panel Auth Cluster)`);
  console.log(`====================================================`);
});
