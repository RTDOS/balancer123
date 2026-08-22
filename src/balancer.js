/**
 * AntiLag VPN Router & Load Balancer State Manager
 * Handles Gaming Mode (Sticky IP), Web Mode (Fast Switch), Target IP Affinity, Parallel Racing, Country Group Ordering, and Real-time Socket Traffic Monitoring.
 */

const crypto = require('crypto');

function getStickyKey(targetHost) {
  if (!targetHost || typeof targetHost !== 'string') return 'default';
  
  const host = targetHost.trim().toLowerCase();

  // If IPv4 (e.g. 142.251.155.2) -> group by /24 subnet: 142.251.155.0
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    const parts = host.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  // If Domain (e.g. rr3---sn-2ohpa5-5c.googlevideo.com) -> extract base domain
  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return host;
}

class AntiLagBalancer {
  constructor() {
    this.mode = 'gaming'; // 'gaming' | 'web'
    this.nodes = [];
    this.countryOrder = []; // Array of countryNames for custom ordering
    this.activeOutboundId = null;
    this.ipAffinityMap = new Map(); // Target IP -> Node ID mapping
    this.clusterKey = crypto.randomBytes(32).toString('hex'); // 64-char SHA-256 cluster key
    this.bypassRuTraffic = true; // Default ON: Route .ru / .рф / RU services directly without VPN
    this.connectionLogs = []; // Rolling log of active connections (max 50)
    this.stats = {
      totalRoutedConnections: 0,
      microLagPreventedCount: 0,
      totalBytesDownloaded: 0,
      totalBytesUploaded: 0,
      activeSockets: []
    };
  }

  isRuDomain(targetHost) {
    if (!targetHost || typeof targetHost !== 'string') return false;
    const host = targetHost.trim().toLowerCase();

    if (host.endsWith('.ru') || host.endsWith('.su') || host.endsWith('.рф') || host.endsWith('.ru.com') || host.endsWith('.ru.net') || host.endsWith('.by')) {
      return true;
    }

    const ruDomains = [
      'yandex.ru', 'ya.ru', 'yandex.net', 'yastatic.net', 'vk.com', 'vk.ru', 'vkontakte.ru',
      'mail.ru', 'ok.ru', 'gosuslugi.ru', 'sberbank.ru', 'sber.ru', 'tbank.ru', 'tinkoff.ru',
      'ozon.ru', 'wildberries.ru', 'avito.ru', 'rutube.ru', 'kinopoisk.ru', 'dzen.ru',
      'rambler.ru', '2gis.ru', 'mos.ru', 'nspk.ru', 'mirconnect.ru', 'gazprom.ru', 'vtb.ru',
      'alfabank.ru', 'raiffeisen.ru', 'ria.ru', 'tass.ru', 'rbc.ru', 'lenta.ru', 'habr.com'
    ];

    for (const d of ruDomains) {
      if (host === d || host.endsWith('.' + d)) return true;
    }

    return false;
  }

  isSelfOrLoopTarget(targetHost, targetIp) {
    const host = (targetHost || '').trim().toLowerCase();
    const ip = (targetIp || '').trim().toLowerCase();

    if (!host && !ip) return false;

    // 1. Localhost / Loopback / LAN IPs
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || host === 'localhost' || ip === '::1') return true;
    if (ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) return true;

    // 2. Prevent routing loop: Check against all registered VPN node IPs and hosts
    for (const node of this.nodes) {
      const nodeIp = (node.ip || node.serverIp || node.host || '').trim().toLowerCase();
      if (nodeIp) {
        if (ip === nodeIp || host === nodeIp || host.startsWith(nodeIp) || (node.raw && node.raw.includes(host))) {
          return true;
        }
      }
    }

    return false;
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

    const rawHost = meta.displayTarget || targetIp || '';

    // 0a. Anti-Loop Guard (Prevent Routing Loops to VPN Node IPs / Localhost / Self Target)
    if (this.isSelfOrLoopTarget(rawHost, targetIp)) {
      const directLoopNode = {
        id: 'direct_anti_loop',
        name: 'Direct (Anti-Loop Guard)',
        flag: '🛡️',
        countryName: 'Direct Loop Protection',
        ping: 1,
        jitter: 0,
        lossRatio: 0,
        status: 'active'
      };
      return this.createSocketRecord(targetIp, targetPort, protocol, directLoopNode, 'Anti-Loop Guard: Self/Node Loop Prevented', meta);
    }

    // 0b. Check RU Traffic Bypass Filter (Direct Connection for .ru / Russian Services)
    if (this.bypassRuTraffic && this.isRuDomain(rawHost)) {
      const directRuNode = {
        id: 'direct_ru',
        name: 'Direct (RU Bypass)',
        flag: '🇷🇺',
        countryName: 'Russia Direct',
        ping: 2,
        jitter: 0,
        lossRatio: 0,
        status: 'active'
      };
      return this.createSocketRecord(targetIp, targetPort, protocol, directRuNode, 'Direct RU Traffic Bypass (No VPN)', meta);
    }

    const activeNodes = this.nodes.filter(n => n.status !== 'dead');
    if (activeNodes.length === 0) {
      return { node: null, reason: 'No active nodes available' };
    }

    const stickyKey = getStickyKey(rawHost);

    // 1. Check Sticky Domain / Subnet Affinity
    let boundNodeId = this.ipAffinityMap.get(stickyKey) || this.ipAffinityMap.get(targetIp);
    
    if (boundNodeId) {
      const boundNode = activeNodes.find(n => n.id === boundNodeId);
      if (boundNode && boundNode.lossRatio < 30 && boundNode.ping < 500) {
        return this.createSocketRecord(targetIp, targetPort, protocol, boundNode, 'Domain Sticky Affinity (Anti-Flap)', meta);
      }
    }

    // 2. Select optimal node with Hysteresis Stability (prevent 1ms ping jitter swapping)
    const sorted = [...activeNodes].sort((a, b) => {
      const scoreA = a.ping + (a.jitter * 2) + (a.lossRatio * 15);
      const scoreB = b.ping + (b.jitter * 2) + (b.lossRatio * 15);
      return scoreA - scoreB;
    });

    let bestNode = sorted[0];

    // If active primary node is healthy and within 20ms of absolute best, stick to primary node!
    if (this.activeOutboundId) {
      const currentPrimaryNode = activeNodes.find(n => n.id === this.activeOutboundId);
      if (currentPrimaryNode && currentPrimaryNode.lossRatio < 20) {
        const scorePrimary = currentPrimaryNode.ping + (currentPrimaryNode.jitter * 2) + (currentPrimaryNode.lossRatio * 15);
        const scoreBest = bestNode.ping + (bestNode.jitter * 2) + (bestNode.lossRatio * 15);
        if (scorePrimary - scoreBest < 25) { // less than 25ms score difference -> stay on current primary
          bestNode = currentPrimaryNode;
        }
      }
    }

    // Update IP & Domain Affinity
    this.ipAffinityMap.set(stickyKey, bestNode.id);
    if (targetIp) this.ipAffinityMap.set(targetIp, bestNode.id);
    this.activeOutboundId = bestNode.id;

    return this.createSocketRecord(targetIp, targetPort, protocol, bestNode, `Routed to stable node (${bestNode.ping}ms)`, meta);
  }

  createSocketRecord(targetIp, targetPort, protocol, node, reason, meta = {}) {
    const socketId = meta.socketId || Math.random().toString(36).substring(2, 10);
    const displayTarget = meta.displayTarget || targetIp || meta.user || '8.8.8.8';

    const socketInfo = {
      id: socketId,
      targetIp: displayTarget,
      targetPort,
      protocol,
      inboundPort: meta.inboundPort || 1080,
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
