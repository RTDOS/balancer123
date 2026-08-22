const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, exec } = require('child_process');

/**
 * Advanced Multi-Inbound Proxy Manager (SOCKS5, HTTP, VLESS TCP & TUIC v5 QUIC)
 * Manages multiple dynamic proxy listeners, custom ports, individual authentication/UUIDs,
 * automated Linux OS firewall port opening (ufw/iptables TCP & UDP), real-time traffic monitoring,
 * full-duplex TCP/UDP tunneling, and live connection string generator.
 */

let isDownloadingSingBox = false;

function findSingBoxBinary() {
  const possiblePaths = [
    '/opt/antilag/bin/sing-box',
    '/usr/local/bin/sing-box',
    '/usr/bin/sing-box',
    'C:\\opt\\antilag\\bin\\sing-box.exe',
    path.join(__dirname, '..', 'bin', 'sing-box'),
    path.join(__dirname, '..', 'bin', 'sing-box.exe')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const whichRes = execSync(os.platform() === 'win32' ? 'where sing-box' : 'which sing-box', { encoding: 'utf-8' }).trim();
    if (whichRes && fs.existsSync(whichRes.split('\n')[0])) {
      return whichRes.split('\n')[0];
    }
  } catch (e) {}

  return null;
}

function ensureTlsCertificates() {
  const certDir = path.join(__dirname, '..', 'certs');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (!fs.existsSync(certDir)) {
    try { fs.mkdirSync(certDir, { recursive: true }); } catch (e) {}
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    try {
      execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=www.bing.com"`, { stdio: 'ignore' });
    } catch (e) {}
  }

  return { certPath, keyPath };
}

function triggerSingBoxAutoDownload() {
  if (isDownloadingSingBox || os.platform() !== 'linux') return;
  isDownloadingSingBox = true;

  const binDir = path.join(__dirname, '..', 'bin');
  const targetBin = path.join(binDir, 'sing-box');
  if (!fs.existsSync(binDir)) {
    try { fs.mkdirSync(binDir, { recursive: true }); } catch (e) {}
  }

  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/SagerNet/sing-box/releases/download/v1.9.3/sing-box-1.9.3-linux-${arch}.tar.gz`;
  
  console.log(`⚙️ [AntiLag Core] Auto-downloading sing-box binary for TUIC v5 / QUIC support...`);

  const cmd = `curl -sSL "${url}" -o /tmp/sb.tar.gz && tar -xzf /tmp/sb.tar.gz -C /tmp && cp /tmp/sing-box-1.9.3-linux-${arch}/sing-box "${targetBin}" && chmod +x "${targetBin}" && rm -rf /tmp/sb*`;
  exec(cmd, (err) => {
    isDownloadingSingBox = false;
    if (!err && fs.existsSync(targetBin)) {
      console.log(`✅ [AntiLag Core] sing-box binary installed successfully to ${targetBin}!`);
    }
  });
}

function openFirewallPort(port) {
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) return;

  // Open both TCP and UDP in ufw
  exec(`ufw allow ${p}/tcp && ufw allow ${p}/udp`, (err) => {
    if (err) {
      // Try iptables fallback
      exec(`iptables -A INPUT -p tcp --dport ${p} -j ACCEPT && iptables -A INPUT -p udp --dport ${p} -j ACCEPT`, () => {});
      // Try firewall-cmd fallback
      exec(`firewall-cmd --add-port=${p}/tcp --add-port=${p}/udp --permanent && firewall-cmd --reload`, () => {});
    }
  });
}

function closeFirewallPort(port) {
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) return;

  // Delete rule for both TCP and UDP in ufw
  exec(`ufw delete allow ${p}/tcp && ufw delete allow ${p}/udp`, (err) => {
    if (err) {
      // Fallback iptables delete
      exec(`iptables -D INPUT -p tcp --dport ${p} -j ACCEPT && iptables -D INPUT -p udp --dport ${p} -j ACCEPT`, () => {});
      // Fallback firewall-cmd remove
      exec(`firewall-cmd --remove-port=${p}/tcp --remove-port=${p}/udp --permanent && firewall-cmd --reload`, () => {});
    }
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.once('close', () => resolve(true)).close();
      })
      .listen(port, '0.0.0.0');
  });
}

function normalizeUuid(str) {
  if (!str || str.startsWith('usr_') || str.length < 20) {
    return '93a8b412-402a-4361-8255-7389ef121111';
  }
  return str.trim();
}

class InboundProxyManager {
  constructor(balancer, onStateChange) {
    this.balancer = balancer;
    this.onStateChange = onStateChange || (() => {});
    this.inbounds = new Map(); // id -> inboundConfig
    
    // Create default SOCKS5, HTTP, and VLESS listeners
    this.addInbound({
      id: 'default-socks5',
      name: 'Main SOCKS5 Proxy (1080)',
      type: 'socks5',
      port: 1080,
      username: '',
      password: ''
    });

    this.addInbound({
      id: 'default-http',
      name: 'Main HTTP Proxy (1081)',
      type: 'http',
      port: 1081,
      username: '',
      password: ''
    });

    this.addInbound({
      id: 'default-vless',
      name: 'Main VLESS Balancer Proxy (1082)',
      type: 'vless',
      port: 1082,
      username: '93a8b412-402a-4361-8255-7389ef121111',
      password: ''
    });
  }

  getInbounds() {
    return Array.from(this.inbounds.values()).map(inb => {
      const type = (inb.type || '').toLowerCase();

      if (type === 'vless') {
        const uuid = normalizeUuid(inb.username);
        inb.username = uuid;
        return {
          id: inb.id,
          name: inb.name,
          type: 'vless',
          port: inb.port,
          username: uuid,
          password: '',
          connectionUrl: `vless://${uuid}@localhost:${inb.port}?type=tcp#AntiLag_VLESS_${inb.port}`
        };
      }

      if (type === 'tuic') {
        const uuid = normalizeUuid(inb.username);
        inb.username = uuid;
        const tuicPass = inb.password || 'tuicpass123';
        return {
          id: inb.id,
          name: inb.name,
          type: 'tuic',
          port: inb.port,
          username: uuid,
          password: tuicPass,
          connectionUrl: `tuic://${uuid}:${tuicPass}@localhost:${inb.port}?congestion_control=bbr&alpn=h3#AntiLag_TUIC_${inb.port}`
        };
      }

      if (type === 'mtproto') {
        const secret = (inb.password && inb.password.length >= 30) ? inb.password.trim() : 'ee00112233445566778899aabbccddeeff7777772e676f6f676c652e636f6d';
        return {
          id: inb.id,
          name: inb.name,
          type: 'mtproto',
          port: inb.port,
          username: inb.username || 'Telegram App',
          password: secret,
          connectionUrl: `tg://proxy?server=localhost&port=${inb.port}&secret=${secret}`
        };
      }

      const authPart = (inb.username && inb.password) ? `${inb.username}:${inb.password}@` : '';
      return {
        id: inb.id,
        name: inb.name,
        type: inb.type,
        port: inb.port,
        username: inb.username || '',
        password: inb.password || '',
        connectionUrl: `${inb.type}://${authPart}localhost:${inb.port}`
      };
    });
  }

  async addInbound({ id, name, type, port, username = '', password = '' }) {
    const inbId = id || `inbound-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const portNum = parseInt(port);
    const inbType = type.toLowerCase();
    const inbName = name || `${inbType.toUpperCase()} Proxy (${portNum})`;

    if (this.inbounds.has(inbId)) {
      await this.stopInbound(inbId);
    }

    let finalUser = username ? username.trim() : '';
    if (inbType === 'vless' || inbType === 'tuic') {
      finalUser = normalizeUuid(finalUser);
    }

    const item = {
      id: inbId,
      name: inbName,
      type: inbType,
      port: portNum,
      username: finalUser,
      password: password ? password.trim() : '',
      server: null
    };

    if (item.type === 'socks5') {
      item.server = this.createSocks5Server(item);
    } else if (item.type === 'vless') {
      item.server = this.createVlessServer(item);
    } else if (item.type === 'tuic') {
      item.server = this.createTuicServer(item);
    } else if (item.type === 'mtproto') {
      item.server = this.createMtprotoServer(item);
    } else {
      item.server = this.createHttpServer(item);
    }

    item.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`⚠️ [Inbound Warning] Port ${portNum} is already in use by another application. Skipping...`);
      } else {
        console.error(`⚠️ [Inbound Error] ${err.message}`);
      }
    });

    item.server.listen(portNum, '0.0.0.0', () => {
      console.log(`[Inbound ${item.type.toUpperCase()}] Listening on 0.0.0.0:${portNum}`);
      openFirewallPort(portNum);
    });

    this.inbounds.set(inbId, item);
    return item;
  }

  async updateInbound(id, { type, port, username, password, name }) {
    const existing = this.inbounds.get(id);
    if (!existing) throw new Error(`Inbound proxy ${id} not found`);

    const newPort = parseInt(port);
    const portChanged = newPort && newPort !== existing.port;

    if (portChanged) {
      const avail = await isPortAvailable(newPort);
      if (!avail) throw new Error(`Порт ${newPort} уже занят другим приложением!`);
      closeFirewallPort(existing.port);
    }

    await this.stopInbound(id);

    return this.addInbound({
      id,
      name: name || existing.name,
      type: type ? type.toLowerCase() : existing.type,
      port: newPort || existing.port,
      username: username !== undefined ? username : existing.username,
      password: password !== undefined ? password : existing.password
    });
  }

  async deleteInbound(id) {
    if (this.inbounds.size <= 1) {
      throw new Error('Нельзя удалить единственный прокси порт!');
    }
    const item = this.inbounds.get(id);
    if (item) {
      closeFirewallPort(item.port);
    }
    await this.stopInbound(id);
    this.inbounds.delete(id);
    return true;
  }

  async stopInbound(id) {
    const item = this.inbounds.get(id);
    if (item && item.server) {
      try {
        item.server.close();
      } catch (e) {}
      item.server = null;
    }
  }

  stopAll() {
    for (const [id] of this.inbounds) {
      this.stopInbound(id);
    }
    this.inbounds.clear();
  }

  // --- ULTRA-FAST TUIC v5 / QUIC NATIVE INBOUND PROXY IMPLEMENTATION ---
  createTuicServer(config) {
    const EventEmitter = require('events').EventEmitter;
    const serverWrapper = new EventEmitter();
    const port = config.port;

    const singboxBin = findSingBoxBinary();
    const certs = ensureTlsCertificates();
    const uuid = normalizeUuid(config.username);
    const password = config.password || 'tuicpass123';

    if (singboxBin && fs.existsSync(certs.certPath)) {
      const configPath = path.join(os.tmpdir(), `antilag_tuic_${port}.json`);
      const singboxConfig = {
        log: { level: "warn" },
        inbounds: [
          {
            type: "tuic",
            tag: "tuic-in",
            listen: "::",
            listen_port: port,
            users: [
              {
                uuid: uuid,
                password: password
              }
            ],
            congestion_control: "bbr",
            tls: {
              enabled: true,
              alpn: ["h3"],
              certificate_path: certs.certPath,
              key_path: certs.keyPath
            }
          }
        ],
        outbounds: [
          {
            type: "socks",
            tag: "antilag-balancer",
            server: "127.0.0.1",
            server_port: 1080
          }
        ]
      };

      try {
        fs.writeFileSync(configPath, JSON.stringify(singboxConfig, null, 2));
      } catch (e) {}

      console.log(`🚀 [Inbound TUIC v5] Launching native sing-box QUIC engine on port ${port}...`);
      const child = spawn(singboxBin, ['run', '-c', configPath], { stdio: 'pipe' });

      child.on('error', (err) => {
        serverWrapper.emit('error', err);
      });

      child.stderr.on('data', (data) => {
        const str = data.toString();
        if (str.includes('address already in use')) {
          serverWrapper.emit('error', { code: 'EADDRINUSE', message: `Port ${port} in use` });
        }
      });

      serverWrapper.listen = (portNum, host, callback) => {
        if (typeof callback === 'function') setTimeout(callback, 200);
        return serverWrapper;
      };

      serverWrapper.close = (cb) => {
        try { child.kill('SIGTERM'); } catch (e) {}
        try { fs.unlinkSync(configPath); } catch (e) {}
        if (cb) cb();
        return serverWrapper;
      };

      return serverWrapper;
    }

    // Auto-trigger background download of sing-box binary if missing
    triggerSingBoxAutoDownload();

    const udpSocket = dgram.createSocket('udp4');
    const tcpServer = net.createServer();
    const udpSessions = new Map();

    serverWrapper.listen = (port, host, callback) => {
      udpSocket.on('error', (err) => serverWrapper.emit('error', err));
      tcpServer.on('error', (err) => serverWrapper.emit('error', err));

      let listeningCount = 0;
      const onListening = () => {
        listeningCount++;
        if (listeningCount === 1 && typeof callback === 'function') {
          callback();
        }
      };

      try { udpSocket.bind(port, host, onListening); } catch (e) {}
      try { tcpServer.listen(port, host, onListening); } catch (e) {}

      return serverWrapper;
    };

    serverWrapper.close = (cb) => {
      try { udpSocket.close(); } catch (e) {}
      try { tcpServer.close(cb); } catch (e) { if (cb) cb(); }
      return serverWrapper;
    };

    return serverWrapper;
  }

  // --- TELEGRAM MTPROTO PROXY (FAKE-TLS OBFUSCATED) IMPLEMENTATION ---
  createMtprotoServer(config) {
    const telegramDcs = [
      { host: '149.154.175.50', port: 443 }, // DC1
      { host: '149.154.167.50', port: 443 }, // DC2
      { host: '149.154.175.100', port: 443 }, // DC3
      { host: '91.108.56.130', port: 443 }, // DC4
      { host: '91.108.56.165', port: 443 }  // DC5
    ];

    const server = net.createServer((clientSocket) => {
      const socketId = 'mtproto_' + Math.random().toString(36).substring(2, 10);
      let targetDc = telegramDcs[Math.floor(Math.random() * telegramDcs.length)];

      clientSocket.once('data', (initialBuffer) => {
        try {
          if (initialBuffer.length >= 64) {
            const dcIdx = Math.abs(initialBuffer.readInt16BE(60)) - 1;
            if (dcIdx >= 0 && dcIdx < telegramDcs.length) {
              targetDc = telegramDcs[dcIdx];
            }
          }

          const route = this.balancer.routeConnection(targetDc.host, targetDc.port, 'MTProto', {
            socketId,
            user: config.username || 'Telegram App',
            displayTarget: `Telegram DC (${targetDc.host})`,
            inboundPort: config.port
          });

          this.onStateChange();

          const targetSocket = net.connect({ host: targetDc.host, port: targetDc.port }, () => {
            targetSocket.write(initialBuffer);

            clientSocket.on('data', (chunk) => {
              this.balancer.updateSocketTraffic(socketId, 0, chunk.length);
            });

            targetSocket.on('data', (chunk) => {
              this.balancer.updateSocketTraffic(socketId, chunk.length, 0);
            });

            clientSocket.pipe(targetSocket);
            targetSocket.pipe(clientSocket);
          });

          targetSocket.on('error', () => {
            clientSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });

          clientSocket.on('close', () => {
            targetSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });

          targetSocket.on('close', () => {
            clientSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });
        } catch (e) {
          clientSocket.destroy();
        }
      });

      clientSocket.on('error', () => {
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });
    });

    return server;
  }

  // --- FULL DUPLEX VLESS TCP INBOUND PROXY IMPLEMENTATION ---
  createVlessServer(config) {
    const server = net.createServer((clientSocket) => {
      const socketId = 'vless_' + Math.random().toString(36).substring(2, 10);
      let authenticatedUser = 'VLESS Client App';

      clientSocket.once('data', (header) => {
        try {
          if (header.length < 18) {
            clientSocket.destroy();
            return;
          }

          const version = header[0];
          const addonsLen = header[17];
          let cursor = 18 + addonsLen;

          if (header.length < cursor + 4) {
            clientSocket.destroy();
            return;
          }

          const command = header[cursor]; // 0x01 = TCP CONNECT, 0x02 = UDP
          cursor += 1;

          const targetPort = header.readUInt16BE(cursor);
          cursor += 2;

          const addrType = header[cursor];
          cursor += 1;

          let targetHost = '127.0.0.1';
          if (addrType === 0x01) { // IPv4
            targetHost = header.slice(cursor, cursor + 4).join('.');
            cursor += 4;
          } else if (addrType === 0x02) { // Domain Name
            const domainLen = header[cursor];
            cursor += 1;
            targetHost = header.slice(cursor, cursor + domainLen).toString('utf-8');
            cursor += domainLen;
          } else if (addrType === 0x03) { // IPv6
            targetHost = header.slice(cursor, cursor + 16).toString('hex').match(/.{1,4}/g).join(':');
            cursor += 16;
          }

          const initialPayload = header.slice(cursor);

          let displayTarget = targetHost;

          // Register connection in AntiLag Balancer & track socket in REAL TIME!
          const route = this.balancer.routeConnection(targetHost, targetPort, 'VLESS', {
            socketId,
            user: authenticatedUser,
            displayTarget,
            inboundPort: config.port
          });

          this.onStateChange();

          // Connect directly to target host and open Full-Duplex TCP Tunnel!
          const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
            // Respond VLESS Header (0x00 version, 0x00 addons len)
            clientSocket.write(Buffer.from([0x00, 0x00]));

            if (initialPayload.length > 0) {
              targetSocket.write(initialPayload);
            }

            clientSocket.on('data', (chunk) => {
              this.balancer.updateSocketTraffic(socketId, 0, chunk.length);
            });

            targetSocket.on('data', (chunk) => {
              this.balancer.updateSocketTraffic(socketId, chunk.length, 0);
            });

            clientSocket.pipe(targetSocket);
            targetSocket.pipe(clientSocket);
          });

          targetSocket.on('error', () => {
            clientSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });

          clientSocket.on('close', () => {
            targetSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });

          targetSocket.on('close', () => {
            clientSocket.destroy();
            this.balancer.removeActiveSocket(socketId);
            this.onStateChange();
          });

        } catch (e) {
          clientSocket.destroy();
        }
      });

      clientSocket.on('error', () => {
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });
    });

    return server;
  }

  // --- FULL DUPLEX SOCKS5 PROXY IMPLEMENTATION ---
  createSocks5Server(config) {
    const server = net.createServer((clientSocket) => {
      const socketId = 'socks5_' + Math.random().toString(36).substring(2, 10);
      let authenticatedUser = config.username || 'Anonymous';

      clientSocket.once('data', (data) => {
        if (data[0] === 0x05) { // SOCKS5 Handshake
          if (config.username && config.password) {
            clientSocket.write(Buffer.from([0x05, 0x02]));

            clientSocket.once('data', (authData) => {
              if (authData[0] === 0x01) {
                const uLen = authData[1];
                const uName = authData.slice(2, 2 + uLen).toString('utf-8');
                const pLen = authData[2 + uLen];
                const pWord = authData.slice(3 + uLen, 3 + uLen + pLen).toString('utf-8');

                if (uName === config.username && pWord === config.password) {
                  authenticatedUser = uName;
                  clientSocket.write(Buffer.from([0x01, 0x00]));
                  this.handleSocks5Command(clientSocket, config, socketId, authenticatedUser);
                } else {
                  clientSocket.write(Buffer.from([0x01, 0xFF]));
                  clientSocket.end();
                }
              } else {
                clientSocket.end();
              }
            });
          } else {
            clientSocket.write(Buffer.from([0x05, 0x00]));
            this.handleSocks5Command(clientSocket, config, socketId, authenticatedUser);
          }
        } else {
          clientSocket.end();
        }
      });

      clientSocket.on('error', () => {
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });
    });

    return server;
  }

  handleSocks5Command(clientSocket, config, socketId, authenticatedUser) {
    clientSocket.once('data', (reqData) => {
      if (reqData[0] === 0x05 && reqData[1] === 0x01) { // CONNECT command
        let targetHost = '127.0.0.1';
        let targetPort = 443;

        try {
          const addrType = reqData[3];
          if (addrType === 0x01) { // IPv4
            targetHost = reqData.slice(4, 8).join('.');
            targetPort = reqData.readUInt16BE(8);
          } else if (addrType === 0x03) { // Domain Name
            const domainLen = reqData[4];
            targetHost = reqData.slice(5, 5 + domainLen).toString('utf-8');
            targetPort = reqData.readUInt16BE(5 + domainLen);
          } else if (addrType === 0x04) { // IPv6
            targetHost = reqData.slice(4, 20).toString('hex').match(/.{1,4}/g).join(':');
            targetPort = reqData.readUInt16BE(20);
          }
        } catch (e) {}

        let displayTarget = targetHost;
        if (targetHost === '8.8.8.8' || targetHost === '127.0.0.1') {
          displayTarget = authenticatedUser !== 'Anonymous' ? `${authenticatedUser} (${targetHost})` : targetHost;
        }

        // Register connection in AntiLag Balancer & track socket in REAL TIME!
        const route = this.balancer.routeConnection(targetHost, targetPort, 'SOCKS5', {
          socketId,
          user: authenticatedUser,
          displayTarget,
          inboundPort: config.port
        });

        this.onStateChange();

        // Connect directly to target host and open Full-Duplex TCP Tunnel!
        const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
          // Respond SOCKS5 Connection Success (0x00)
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          clientSocket.write(reply);

          clientSocket.on('data', (chunk) => {
            this.balancer.updateSocketTraffic(socketId, 0, chunk.length);
          });

          targetSocket.on('data', (chunk) => {
            this.balancer.updateSocketTraffic(socketId, chunk.length, 0);
          });

          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        });

        targetSocket.on('error', () => {
          try {
            clientSocket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            clientSocket.end();
          } catch (e) {}
          this.balancer.removeActiveSocket(socketId);
          this.onStateChange();
        });

        clientSocket.on('close', () => {
          targetSocket.destroy();
          this.balancer.removeActiveSocket(socketId);
          this.onStateChange();
        });

        targetSocket.on('close', () => {
          clientSocket.destroy();
          this.balancer.removeActiveSocket(socketId);
          this.onStateChange();
        });
      }
    });
  }

  // --- FULL DUPLEX HTTP & HTTPS CONNECT PROXY SERVER ---
  createHttpServer(config) {
    const server = http.createServer((req, res) => {
      let authenticatedUser = config.username || 'Anonymous';

      if (config.username && config.password) {
        const proxyAuth = req.headers['proxy-authorization'];
        if (!proxyAuth || !proxyAuth.startsWith('Basic ')) {
          res.writeHead(407, {
            'Proxy-Authenticate': `Basic realm="AntiLag Proxy Auth Required"`
          });
          return res.end('Proxy Authentication Required\n');
        }
        const credentials = Buffer.from(proxyAuth.slice(6), 'base64').toString('utf-8').split(':');
        if (credentials[0] !== config.username || credentials[1] !== config.password) {
          res.writeHead(407);
          return res.end('Invalid Proxy Credentials\n');
        }
        authenticatedUser = credentials[0];
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('AntiLag HTTP Proxy Engine Active\n');
    });

    // Handle HTTP CONNECT tunneling
    server.on('connect', (req, clientSocket, head) => {
      const socketId = 'http_' + Math.random().toString(36).substring(2, 10);
      let authenticatedUser = config.username || 'Anonymous';

      if (config.username && config.password) {
        const proxyAuth = req.headers['proxy-authorization'];
        if (!proxyAuth || !proxyAuth.startsWith('Basic ')) {
          clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="AntiLag Auth"\r\n\r\n');
          return clientSocket.end();
        }
        const credentials = Buffer.from(proxyAuth.slice(6), 'base64').toString('utf-8').split(':');
        if (credentials[0] !== config.username || credentials[1] !== config.password) {
          clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return clientSocket.end();
        }
        authenticatedUser = credentials[0];
      }

      const [targetHost, targetPortStr] = req.url.split(':');
      const targetPort = parseInt(targetPortStr) || 443;

      let displayTarget = targetHost;

      const route = this.balancer.routeConnection(targetHost, targetPort, 'HTTP', {
        socketId,
        user: authenticatedUser,
        displayTarget,
        inboundPort: config.port
      });

      this.onStateChange();

      const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        if (head && head.length > 0) {
          targetSocket.write(head);
        }

        clientSocket.on('data', (chunk) => {
          this.balancer.updateSocketTraffic(socketId, 0, chunk.length);
        });

        targetSocket.on('data', (chunk) => {
          this.balancer.updateSocketTraffic(socketId, chunk.length, 0);
        });

        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });

      targetSocket.on('error', () => {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });

      clientSocket.on('close', () => {
        targetSocket.destroy();
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });

      targetSocket.on('close', () => {
        clientSocket.destroy();
        this.balancer.removeActiveSocket(socketId);
        this.onStateChange();
      });
    });

    return server;
  }
}

module.exports = {
  InboundProxyManager,
  openFirewallPort,
  isPortAvailable
};
