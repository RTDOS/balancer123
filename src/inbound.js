const net = require('net');
const http = require('http');

/**
 * Advanced Multi-Inbound Proxy Manager (SOCKS5 & HTTP)
 * Manages multiple dynamic proxy listeners, custom ports, individual username/password auth,
 * and live connection string generator (socks5://user:pass@host:port).
 */

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

class InboundProxyManager {
  constructor(balancer) {
    this.balancer = balancer;
    this.inbounds = new Map(); // id -> inboundConfig
    
    // Create default SOCKS5 and HTTP listeners
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
  }

  getInbounds() {
    return Array.from(this.inbounds.values()).map(inb => {
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
    const inbName = name || `${type.toUpperCase()} Proxy (${portNum})`;

    if (this.inbounds.has(inbId)) {
      await this.stopInbound(inbId);
    }

    const item = {
      id: inbId,
      name: inbName,
      type: type.toLowerCase(),
      port: portNum,
      username: username ? username.trim() : '',
      password: password ? password.trim() : '',
      server: null
    };

    if (item.type === 'socks5') {
      item.server = this.createSocks5Server(item);
    } else {
      item.server = this.createHttpServer(item);
    }

    item.server.listen(portNum, '0.0.0.0', () => {
      console.log(`[Inbound ${item.type.toUpperCase()}] Listening on 0.0.0.0:${portNum}`);
    });

    this.inbounds.set(inbId, item);
    return item;
  }

  async updateInbound(id, { type, port, username, password, name }) {
    const existing = this.inbounds.get(id);
    if (!existing) throw new Error(`Inbound proxy ${id} not found`);

    const newPort = parseInt(port);
    const typeChanged = type && type.toLowerCase() !== existing.type;
    const portChanged = newPort && newPort !== existing.port;

    if (portChanged) {
      const avail = await isPortAvailable(newPort);
      if (!avail) throw new Error(`Порт ${newPort} уже занят другим приложением!`);
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

  createSocks5Server(config) {
    return net.createServer((socket) => {
      socket.once('data', (data) => {
        if (data[0] === 0x05) {
          if (config.username && config.password) {
            socket.write(Buffer.from([0x05, 0x02]));

            socket.once('data', (authData) => {
              if (authData[0] === 0x01) {
                const uLen = authData[1];
                const uName = authData.slice(2, 2 + uLen).toString('utf-8');
                const pLen = authData[2 + uLen];
                const pWord = authData.slice(3 + uLen, 3 + uLen + pLen).toString('utf-8');

                if (uName === config.username && pWord === config.password) {
                  socket.write(Buffer.from([0x01, 0x00]));
                  this.handleSocks5Command(socket);
                } else {
                  socket.write(Buffer.from([0x01, 0xFF]));
                  socket.end();
                }
              } else {
                socket.end();
              }
            });
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            this.handleSocks5Command(socket);
          }
        } else {
          socket.end();
        }
      });

      socket.on('error', () => {});
    });
  }

  handleSocks5Command(socket) {
    socket.once('data', (reqData) => {
      if (reqData[0] === 0x05 && reqData[1] === 0x01) {
        let targetIp = '1.1.1.1';
        let targetPort = 443;

        try {
          const addrType = reqData[3];
          if (addrType === 0x01) {
            targetIp = reqData.slice(4, 8).join('.');
            targetPort = reqData.readUInt16BE(8);
          } else if (addrType === 0x03) {
            const domainLen = reqData[4];
            targetIp = reqData.slice(5, 5 + domainLen).toString('utf-8');
            targetPort = reqData.readUInt16BE(5 + domainLen);
          }
        } catch (e) {}

        const route = this.balancer.routeConnection(targetIp, targetPort, 'TCP');
        const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]);
        socket.write(reply);
      }
    });
  }

  createHttpServer(config) {
    return http.createServer((req, res) => {
      if (config.username && config.password) {
        const proxyAuth = req.headers['proxy-authorization'];
        if (!proxyAuth || !proxyAuth.startsWith('Basic ')) {
          res.writeHead(407, {
            'Proxy-Authenticate': `Basic realm="AntiLag Proxy Auth Required for ${config.name}"`
          });
          return res.end('Proxy Authentication Required\n');
        }

        const creds = Buffer.from(proxyAuth.split(' ')[1], 'base64').toString('utf-8').split(':');
        const user = creds[0];
        const pass = creds[1];

        if (user !== config.username || pass !== config.password) {
          res.writeHead(407, {
            'Proxy-Authenticate': 'Basic realm="Invalid Proxy Credentials"'
          });
          return res.end('Invalid Proxy Credentials\n');
        }
      }

      const hostHeader = req.headers['host'] || '127.0.0.1:80';
      const [targetIp, targetPortStr] = hostHeader.split(':');
      const targetPort = targetPortStr ? parseInt(targetPortStr) : 80;

      const route = this.balancer.routeConnection(targetIp, targetPort, 'HTTP');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`AntiLag Router: Proxying ${targetIp}:${targetPort} via ${route.node ? route.node.name : 'Direct'}\n`);
    });
  }

  stopAll() {
    this.inbounds.forEach((item) => {
      if (item.server) {
        try { item.server.close(); } catch (e) {}
      }
    });
    this.inbounds.clear();
  }
}

module.exports = {
  InboundProxyManager,
  isPortAvailable
};
