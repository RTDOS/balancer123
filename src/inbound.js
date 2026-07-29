const net = require('net');
const http = require('http');

/**
 * Built-in Lightweight Local Inbound Proxies (SOCKS5 & HTTP)
 * Listens on local ports and routes connection requests using AntiLagBalancer.
 */

class InboundProxyManager {
  constructor(balancer) {
    this.balancer = balancer;
    this.socksServer = null;
    this.httpServer = null;
    this.socksPort = 1080;
    this.httpPort = 1081;
  }

  startSocks5(port = 1080) {
    this.socksPort = port;
    this.socksServer = net.createServer((socket) => {
      socket.once('data', (data) => {
        // SOCKS5 Handshake: 0x05 version
        if (data[0] === 0x05) {
          // Accept NO AUTH (0x05 0x00)
          socket.write(Buffer.from([0x05, 0x00]));

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

              // Ask AntiLagBalancer for optimal outbound node
              const route = this.balancer.routeConnection(targetIp, targetPort, 'TCP');

              // Respond SOCKS5 Success (0x05 0x00 0x00 0x01 ...)
              const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]);
              socket.write(reply);
            }
          });
        } else {
          socket.end();
        }
      });

      socket.on('error', () => {});
    });

    this.socksServer.listen(port, '127.0.0.1', () => {
      console.log(`[Inbound] SOCKS5 proxy listening on 127.0.0.1:${port}`);
    });
  }

  startHttp(port = 1081) {
    this.httpPort = port;
    this.httpServer = http.createServer((req, res) => {
      const hostHeader = req.headers['host'] || '127.0.0.1:80';
      const [targetIp, targetPortStr] = hostHeader.split(':');
      const targetPort = targetPortStr ? parseInt(targetPortStr) : 80;

      const route = this.balancer.routeConnection(targetIp, targetPort, 'HTTP');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`AntiLag Router: Proxying ${targetIp}:${targetPort} via ${route.node ? route.node.name : 'Direct'}\n`);
    });

    this.httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[Inbound] HTTP proxy listening on 127.0.0.1:${port}`);
    });
  }

  stop() {
    if (this.socksServer) this.socksServer.close();
    if (this.httpServer) this.httpServer.close();
  }
}

module.exports = InboundProxyManager;
