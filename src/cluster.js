const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { CURRENT_VERSION } = require('./config');

/**
 * Multi-Server High-Availability Cluster & P2P Sync Engine
 * Uses 64-char SHA-256 Cluster Key for encrypted inter-panel authentication.
 * Synchronizes VPN nodes, HTTP/SOCKS inbounds, active sockets, connection logs,
 * AND performs automatic GitHub code auto-updates if version mismatch is detected.
 */

class ClusterEngine {
  constructor(balancer) {
    this.balancer = balancer;
    this.peers = []; // Array of { id, url, clusterKey, version, status: 'online'|'offline'|'error', lastSyncTime, nodeCount, inboundsCount, activeSocketsCount, remoteLogs }
    this.syncIntervalId = null;
    this.isUpdating = false;
  }

  setPeers(peerList) {
    if (Array.isArray(peerList)) {
      this.peers = peerList.map(p => ({
        id: p.id || 'peer_' + Math.random().toString(36).substring(2, 8),
        url: p.url ? p.url.replace(/\/$/, '') : '',
        clusterKey: p.clusterKey || '',
        version: p.version || '4.1.0',
        status: p.status || 'unknown',
        lastSyncTime: p.lastSyncTime || null,
        nodeCount: p.nodeCount || 0,
        inboundsCount: p.inboundsCount || 0,
        activeSocketsCount: p.activeSocketsCount || 0,
        remoteLogs: p.remoteLogs || []
      }));
    }
  }

  addPeer(peerUrl, clusterKey = '') {
    const cleanUrl = peerUrl.replace(/\/$/, '');
    if (this.peers.some(p => p.url === cleanUrl)) return false;

    const peer = {
      id: 'peer_' + Math.random().toString(36).substring(2, 8),
      url: cleanUrl,
      clusterKey: clusterKey ? clusterKey.trim() : '',
      version: CURRENT_VERSION,
      status: 'unknown',
      lastSyncTime: null,
      nodeCount: 0,
      inboundsCount: 0,
      activeSocketsCount: 0,
      remoteLogs: []
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
        clusterKey: peer.clusterKey,
        version: CURRENT_VERSION,
        mode: this.balancer.mode,
        nodes: this.balancer.nodes,
        countryOrder: this.balancer.countryOrder,
        activeSockets: this.balancer.stats.activeSockets || [],
        connectionLogs: this.balancer.getConnectionLogs()
      });

      const urlObj = new URL(`${peer.url}/api/cluster/sync`);
      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.request(urlObj, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Cluster-Token': peer.clusterKey
        },
        timeout: 4000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              peer.status = 'online';
              peer.lastSyncTime = new Date().toLocaleTimeString();
              peer.version = data.version || CURRENT_VERSION;
              peer.nodeCount = data.nodeCount || 0;
              peer.inboundsCount = data.inboundsCount || 0;
              peer.activeSocketsCount = data.activeSocketsCount || 0;
              peer.remoteLogs = data.connectionLogs || [];

              // Auto-update check: If remote version differs, pull latest code from GitHub
              if (data.version && data.version !== CURRENT_VERSION && !this.isUpdating) {
                this.isUpdating = true;
                console.log(`[Cluster Auto-Update] Remote peer version (${data.version}) differs from local (${CURRENT_VERSION}). Pulling latest code from GitHub...`);
                exec('cd /opt/antilag && git pull origin main && npm install --production && systemctl restart antilag', () => {
                  this.isUpdating = false;
                });
              }

              // Merge remote nodes into local balancer
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
        version: p.version || CURRENT_VERSION,
        clusterKey: p.clusterKey ? `${p.clusterKey.substring(0, 8)}...${p.clusterKey.substring(56)}` : 'N/A',
        status: p.status,
        lastSyncTime: p.lastSyncTime,
        nodeCount: p.nodeCount,
        inboundsCount: p.inboundsCount,
        activeSocketsCount: p.activeSocketsCount,
        remoteLogs: p.remoteLogs || []
      }))
    };
  }
}

module.exports = ClusterEngine;
