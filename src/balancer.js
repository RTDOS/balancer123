/**
 * AntiLag VPN Router & Load Balancer State Manager
 * Handles Gaming Mode (Sticky IP), Web Mode (Fast Switch), Target IP Affinity, Parallel Racing, Country Group Ordering, and Real-time Socket Traffic Monitoring.
 */

const crypto = require('crypto');

class AntiLagBalancer {
  constructor() {
    this.mode = 'gaming'; // 'gaming' | 'web'
    this.nodes = [];
    this.countryOrder = []; // Array of countryNames for custom ordering
    this.activeOutboundId = null;
    this.ipAffinityMap = new Map(); // Target IP -> Node ID mapping
    this.clusterKey = crypto.randomBytes(32).toString('hex'); // 64-char SHA-256 cluster key
    this.connectionLogs = []; // Rolling log of active connections (max 50)
    this.stats = {
      totalRoutedConnections: 0,
      microLagPreventedCount: 0,
      totalBytesDownloaded: 0,
      totalBytesUploaded: 0,
      activeSockets: []
    };
  }

  getClusterKey() {
    return this.clusterKey;
  }

  regenerateClusterKey() {
    this.clusterKey = crypto.randomBytes(32).toString('hex');
    return this.clusterKey;
  }

  addConnectionLog(entry) {
    const logItem = {
      timestamp: new Date().toLocaleTimeString(),
      target: entry.target || 'Unknown',
      port: entry.port || 443,
      protocol: entry.protocol || 'SOCKS5',
      node: entry.nodeName || 'Direct',
      user: entry.user || 'Anonymous'
    };
    this.connectionLogs.unshift(logItem);
    if (this.connectionLogs.length > 50) {
      this.connectionLogs.pop();
    }
  }

  getConnectionLogs() {
    return this.connectionLogs;
  }

  setMode(newMode) {
    if (['gaming', 'web'].includes(newMode)) {
      this.mode = newMode;
    }
    return this.mode;
  }

  setNodes(nodesList) {
    this.nodes = nodesList;
    if (!this.activeOutboundId && this.nodes.length > 0) {
      this.activeOutboundId = this.nodes[0].id;
    }
  }

  addNodes(newNodes) {
    const existingRaws = new Set(this.nodes.map(n => n.raw));
    const unique = newNodes.filter(n => !existingRaws.has(n.raw));
    this.nodes.push(...unique);
    if (!this.activeOutboundId && this.nodes.length > 0) {
      this.activeOutboundId = this.nodes[0].id;
    }
    return unique.length;
  }

  removeNode(nodeId) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    if (this.activeOutboundId === nodeId) {
      this.activeOutboundId = this.nodes.length > 0 ? this.nodes[0].id : null;
    }
  }

  updateNode(nodeId, updates) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return null;

    if (updates.name !== undefined) node.name = updates.name.trim();
    if (updates.countryName !== undefined) node.countryName = updates.countryName.trim();
    if (updates.countryCode !== undefined) node.countryCode = updates.countryCode.trim().toUpperCase();
    if (updates.flag !== undefined) node.flag = updates.flag.trim();
    if (updates.serverGroup !== undefined) node.serverGroup = updates.serverGroup.trim();

    return node;
  }

  moveCountryGroup(countryName, direction) {
    const grouped = this.getGroupedNodes();
    const countryNames = grouped.map(g => g.countryName);
    const index = countryNames.indexOf(countryName);

    if (index === -1) return false;

    if (direction === 'up' && index > 0) {
      const temp = countryNames[index];
      countryNames[index] = countryNames[index - 1];
      countryNames[index - 1] = temp;
    } else if (direction === 'down' && index < countryNames.length - 1) {
      const temp = countryNames[index];
      countryNames[index] = countryNames[index + 1];
      countryNames[index + 1] = temp;
    }

    this.countryOrder = countryNames;
    return true;
  }

  // Get active node for a specific target IP or User
  routeConnection(targetIp, targetPort, protocol = 'TCP', meta = {}) {
    this.stats.totalRoutedConnections++;

    const activeNodes = this.nodes.filter(n => n.status !== 'dead');
    if (activeNodes.length === 0) {
      return { node: null, reason: 'No active nodes available' };
    }

    // 1. Check IP Affinity (Sticky Session)
    if (this.ipAffinityMap.has(targetIp)) {
      const boundNodeId = this.ipAffinityMap.get(targetIp);
      const boundNode = activeNodes.find(n => n.id === boundNodeId);

      if (boundNode) {
        if (this.mode === 'gaming') {
          if (boundNode.lossRatio < 25 && boundNode.ping < 450) {
            return this.createSocketRecord(targetIp, targetPort, protocol, boundNode, 'Gaming Protection', meta);
          } else {
            this.stats.microLagPreventedCount++;
          }
        } else {
          if (boundNode.ping < 150 && boundNode.lossRatio < 10) {
            return this.createSocketRecord(targetIp, targetPort, protocol, boundNode, 'Web Fast Path', meta);
          } else {
            this.stats.microLagPreventedCount++;
          }
        }
      }
    }

    // 2. Select optimal node
    const sorted = [...activeNodes].sort((a, b) => {
      const scoreA = a.ping + (a.jitter * 2) + (a.lossRatio * 15);
      const scoreB = b.ping + (b.jitter * 2) + (b.lossRatio * 15);
      return scoreA - scoreB;
    });

    const bestNode = sorted[0];

    // Update IP Affinity
    this.ipAffinityMap.set(targetIp, bestNode.id);
    this.activeOutboundId = bestNode.id;

    return this.createSocketRecord(targetIp, targetPort, protocol, bestNode, `Routed to lowest RTT node (${bestNode.ping}ms)`, meta);
  }

  createSocketRecord(targetIp, targetPort, protocol, node, reason, meta = {}) {
    const socketId = meta.socketId || Math.random().toString(36).substring(2, 10);
    const displayTarget = meta.displayTarget || targetIp || meta.user || '8.8.8.8';

    const socketInfo = {
      id: socketId,
      targetIp: displayTarget,
      targetPort,
      protocol,
      user: meta.user || '',
      bytesRead: 0,
      bytesWritten: 0,
      nodeId: node.id,
      nodeName: node.name,
      nodeFlag: node.flag,
      countryName: node.countryName,
      startTime: new Date().toISOString(),
      startTimestamp: Date.now()
    };

    this.addConnectionLog({
      target: displayTarget,
      port: targetPort,
      protocol,
      nodeName: node.name,
      user: meta.user || 'Anonymous'
    });

    // Replace existing or prepend new active socket
    const idx = this.stats.activeSockets.findIndex(s => s.id === socketId);
    if (idx !== -1) {
      this.stats.activeSockets[idx] = socketInfo;
    } else {
      this.stats.activeSockets.unshift(socketInfo);
      if (this.stats.activeSockets.length > 40) {
        this.stats.activeSockets.pop();
      }
    }

    return {
      node,
      socketId,
      mode: this.mode,
      reason
    };
  }

  updateSocketTraffic(socketId, bytesRead = 0, bytesWritten = 0) {
    const socket = this.stats.activeSockets.find(s => s.id === socketId);
    if (socket) {
      socket.bytesRead += bytesRead;
      socket.bytesWritten += bytesWritten;
    }
    this.stats.totalBytesDownloaded += bytesRead;
    this.stats.totalBytesUploaded += bytesWritten;
  }

  removeActiveSocket(socketId) {
    this.stats.activeSockets = this.stats.activeSockets.filter(s => s.id !== socketId);
  }

  // Get nodes grouped by country with per-country aggregated metrics, unique physical server counts, and custom ordering
  getGroupedNodes() {
    const groups = {};

    // Calculate active connections per node
    const activeNodeConnCounts = {};
    for (const socket of this.stats.activeSockets) {
      activeNodeConnCounts[socket.nodeId] = (activeNodeConnCounts[socket.nodeId] || 0) + 1;
    }

    for (const node of this.nodes) {
      const country = node.countryName || 'Other';
      if (!groups[country]) {
        groups[country] = {
          countryName: country,
          countryCode: node.countryCode,
          flag: node.flag,
          nodes: [],
          totalPing: 0,
          activeConnectionsCount: 0,
          serverSet: new Set()
        };
      }
      groups[country].nodes.push(node);
      groups[country].totalPing += (node.ping || 0);
      groups[country].activeConnectionsCount += (activeNodeConnCounts[node.id] || 0);

      // Track distinct physical server host IP or server group
      const serverKey = node.serverGroup || node.address;
      groups[country].serverSet.add(serverKey);
    }

    const groupList = Object.values(groups).map(g => ({
      countryName: g.countryName,
      countryCode: g.countryCode,
      flag: g.flag,
      nodes: g.nodes,
      totalPing: g.totalPing,
      activeConnectionsCount: g.activeConnectionsCount,
      nodesCount: g.nodes.length,
      serversCount: g.serverSet.size,
      avgPing: g.nodes.length > 0 ? Math.round(g.totalPing / g.nodes.length) : 0
    }));

    // Apply custom country order if defined
    if (this.countryOrder && this.countryOrder.length > 0) {
      groupList.sort((a, b) => {
        const idxA = this.countryOrder.indexOf(a.countryName);
        const idxB = this.countryOrder.indexOf(b.countryName);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
    }

    return groupList;
  }
}

module.exports = AntiLagBalancer;
