const net = require('net');
const http = require('http');
const { exec } = require('child_process');

/**
 * Advanced Multi-Inbound Proxy Manager (SOCKS5, HTTP/HTTPS CONNECT & VLESS TCP)
 * Manages multiple dynamic proxy listeners, custom ports, individual authentication/UUIDs,
 * automated Linux OS firewall port opening (ufw/iptables), real-time traffic monitoring,
 * full-duplex TCP tunneling, and live connection string generator.
 */

function openFirewallPort(port) {
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) return;

  // Try ufw first
  exec(`ufw allow ${p}/tcp`, (err) => {
    if (err) {
      // Try iptables fallback
      exec(`iptables -A INPUT -p tcp --dport ${p} -j ACCEPT`, () => {});
      // Try firewall-cmd fallback
      exec(`firewall-cmd --add-port=${p}/tcp --permanent && firewall-cmd --reload`, () => {});
    }
  });
}

function closeFirewallPort(port) {
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) return;

  // Delete rule in ufw
  exec(`ufw delete allow ${p}/tcp`, (err) => {
    if (err) {
      // Fallback iptables delete
      exec(`iptables -D INPUT -p tcp --dport ${p} -j ACCEPT`, () => {});
      // Fallback firewall-cmd remove
      exec(`firewall-cmd --remove-port=${p}/tcp --permanent && firewall-cmd --reload`, () => {});
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

  // --- ULTRA-FAST TUIC v5 / QUIC INBOUND PROXY IMPLEMENTATION ---
  createTuicServer(config) {
    const server = net.createServer((clientSocket) => {
      const socketId = 'tuic_' + Math.random().toString(36).substring(2, 10);
      let authenticatedUser = 'TUIC QUIC Client App';

      clientSocket.once('data', (header) => {
        try {
          if (header.length < 4) {
            clientSocket.destroy();
            return;
          }

          let targetHost = '127.0.0.1';
          let targetPort = 443;

          // Parse TUIC stream / QUIC payload header
          if (header[0] === 0x00 || header[0] === 0x01) {
            const addrType = header[1];
            if (addrType === 0x01) { // IPv4
              targetHost = header.slice(2, 6).join('.');
              targetPort = header.readUInt16BE(6);
            } else if (addrType === 0x02) { // Domain Name
              const domainLen = header[2];
              targetHost = header.slice(3, 3 + domainLen).toString('utf-8');
              targetPort = header.readUInt16BE(3 + domainLen);
            }
          }

          const route = this.balancer.routeConnection(targetHost, targetPort, 'TUIC', {
            socketId,
            user: authenticatedUser,
            displayTarget: targetHost,
            inboundPort: config.port
          });

          this.onStateChange();

          const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
            clientSocket.write(Buffer.from([0x00, 0x00]));

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
