const net = require('net');
const http = require('http');

/**
 * Built-in Lightweight Inbound Proxies (SOCKS5 & HTTP) with optional Username/Password Auth.
 */

class InboundProxyManager {
  constructor(balancer) {
    this.balancer = balancer;
    this.socksServer = null;
    this.httpServer = null;
    this.socksPort = 1080;
    this.httpPort = 1081;
    this.authRequired = false;
    this.username = 'admin';
    this.password = 'password123';
  }

  setAuth(required, user = 'admin', pass = '') {
    this.authRequired = !!required;
    this.username = user || 'admin';
    this.password = pass || '';
  }

  startSocks5(port = 1080) {
    this.socksPort = port;
    this.socksServer = net.createServer((socket) => {
      socket.once('data', (data) => {
        // SOCKS5 Handshake: 0x05 version
        if (data[0] === 0x05) {
          if (this.authRequired) {
            // Require Username/Password Auth (0x05 0x02)
            socket.write(Buffer.from([0x05, 0x02]));

            socket.once('data', (authData) => {
              if (authData[0] === 0x01) { // Auth version 1
                const uLen = authData[1];
                const uName = authData.slice(2, 2 + uLen).toString('utf-8');
                const pLen = authData[2 + uLen];
                const pWord = authData.slice(3 + uLen, 3 + uLen + pLen).toString('utf-8');

                if (uName === this.username && pWord === this.password) {
                  // Success (0x01 0x00)
                  socket.write(Buffer.from([0x01, 0x00]));
                  this.handleSocks5Command(socket);
                } else {
                  // Failure (0x01 0xFF)
                  socket.write(Buffer.from([0x01, 0xFF]));
                  socket.end();
                }
              } else {
                socket.end();
              }
            });
          } else {
            // Accept NO AUTH (0x05 0x00)
            socket.write(Buffer.from([0x05, 0x00]));
            this.handleSocks5Command(socket);
          }
        } else {
          socket.end();
        }
      });

      socket.on('error', () => {});
    });

    this.socksServer.listen(port, '0.0.0.0', () => {
      console.log(`[Inbound] SOCKS5 proxy listening on 0.0.0.0:${port}`);
    });
  }

  handleSocks5Command(socket) {
    socket.once('data', (reqData) => {
      if (reqData[0] === 0x05 && reqData[1] === 0x01) { // CONNECT command
        let targetIp = '1.1.1.1';
        let targetPort = 443;

        try {
          const addrType = reqData[3];
          if (addrType === 0x01) { // IPv4
            targetIp = reqData.slice(4, 8).join('.');
            targetPort = reqData.readUInt16BE(8);
          } else if (addrType === 0x03) { // Domain
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

  startHttp(port = 1081) {
    this.httpPort = port;
    this.httpServer = http.createServer((req, res) => {
      if (this.authRequired) {
        const proxyAuth = req.headers['proxy-authorization'];
        if (!proxyAuth || !proxyAuth.startsWith('Basic ')) {
          res.writeHead(407, {
            'Proxy-Authenticate': 'Basic realm="AntiLag Proxy Auth Required"'
          });
          return res.end('Proxy Authentication Required\n');
        }

        const creds = Buffer.from(proxyAuth.split(' ')[1], 'base64').toString('utf-8').split(':');
        const user = creds[0];
        const pass = creds[1];

        if (user !== this.username || pass !== this.password) {
          res.writeHead(407, {
            'Proxy-Authenticate': 'Basic realm="Invalid Credentials"'
          });
          return res.end('Invalid Credentials\n');
        }
      }

      const hostHeader = req.headers['host'] || '127.0.0.1:80';
      const [targetIp, targetPortStr] = hostHeader.split(':');
      const targetPort = targetPortStr ? parseInt(targetPortStr) : 80;

      const route = this.balancer.routeConnection(targetIp, targetPort, 'HTTP');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`AntiLag Router: Proxying ${targetIp}:${targetPort} via ${route.node ? route.node.name : 'Direct'}\n`);
    });

    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`[Inbound] HTTP proxy listening on 0.0.0.0:${port}`);
    });
  }

  stop() {
    if (this.socksServer) this.socksServer.close();
    if (this.httpServer) this.httpServer.close();
  }
}

module.exports = InboundProxyManager;
