const http = require('http');
const https = require('https');

/**
 * Multi-Server High-Availability Cluster & P2P Sync Engine
 * Synchronizes VPN nodes, balancer modes, country ordering and health telemetry across 2-3 servers using panel credentials.
 */

class ClusterEngine {
  constructor(balancer) {
    this.balancer = balancer;
    this.peers = []; // Array of { id, url, username, password, status: 'online'|'offline', lastSyncTime }
    this.syncIntervalId = null;
  }

  addPeer(peerUrl, username = 'admin', password = 'admin') {
    const cleanUrl = peerUrl.replace(/\/$/, '');
    if (this.peers.some(p => p.url === cleanUrl)) return false;

    const peer = {
      id: 'peer_' + Math.random().toString(36).substring(2, 8),
      url: cleanUrl,
      username: username || 'admin',
      password: password || 'admin',
      status: 'unknown',
      lastSyncTime: null,
      nodeCount: 0
    };

    this.peers.push(peer);
    this.syncPeer(peer);
    return peer;
  }

  removePeer(peerId) {
    this.peers = this.peers.filter(p => p.id !== peerId);
  }

  startAutoSync(intervalMs = 4000) {
    if (this.syncIntervalId) return;
    this.syncIntervalId = setInterval(() => {
      this.syncAllPeers();
    }, intervalMs);
  }

  stopAutoSync() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  syncAllPeers() {
    for (const peer of this.peers) {
      this.syncPeer(peer);
    }
  }

  async syncPeer(peer) {
    try {
      const payload = JSON.stringify({
        username: peer.username,
        password: peer.password,
        mode: this.balancer.mode,
        nodes: this.balancer.nodes,
        countryOrder: this.balancer.countryOrder
      });

      const urlObj = new URL(`${peer.url}/api/cluster/sync`);
      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.request(urlObj, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 3000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              peer.status = 'online';
              peer.lastSyncTime = new Date().toLocaleTimeString();
              peer.nodeCount = data.nodeCount || 0;

              // Merge remote nodes into local balancer if remote has new nodes
              if (data.nodes && Array.isArray(data.nodes)) {
                this.balancer.addNodes(data.nodes);
              }
            } else {
              peer.status = 'error';
            }
          } catch (e) {
            peer.status = 'error';
          }
        });
      });

      req.on('error', () => {
        peer.status = 'offline';
      });

      req.on('timeout', () => {
        req.destroy();
        peer.status = 'offline';
      });

      req.write(payload);
      req.end();
    } catch (e) {
      peer.status = 'offline';
    }
  }

  getClusterStatus() {
    return {
      activePeersCount: this.peers.filter(p => p.status === 'online').length,
      totalPeersCount: this.peers.length,
      peers: this.peers.map(p => ({
        id: p.id,
        url: p.url,
        username: p.username,
        status: p.status,
        lastSyncTime: p.lastSyncTime,
        nodeCount: p.nodeCount
      }))
    };
  }
}

module.exports = ClusterEngine;
