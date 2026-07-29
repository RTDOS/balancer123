/**
 * AntiLag VPN Router & Load Balancer State Manager
 * Handles Gaming Mode (Sticky IP), Web Mode (Fast Switch), Target IP Affinity, Parallel Racing, and Country Group Ordering.
 */

class AntiLagBalancer {
  constructor() {
    this.mode = 'gaming'; // 'gaming' | 'web'
    this.nodes = [];
    this.countryOrder = []; // Array of countryNames for custom ordering
    this.activeOutboundId = null;
    this.ipAffinityMap = new Map(); // Target IP -> Node ID mapping
    this.stats = {
      totalRoutedConnections: 0,
      microLagPreventedCount: 0,
      activeSockets: []
    };
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

  // Get active node for a specific target IP
  routeConnection(targetIp, targetPort, protocol = 'TCP') {
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
            return {
              node: boundNode,
              mode: 'gaming',
              reason: 'Sticky IP affinity maintained (Gaming Protection)'
            };
          } else {
            this.stats.microLagPreventedCount++;
          }
        } else {
          if (boundNode.ping < 150 && boundNode.lossRatio < 10) {
            return {
              node: boundNode,
              mode: 'web',
              reason: 'Sticky IP affinity maintained (Web Fast Path)'
            };
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

    // Track active socket with exact start timestamp
    const socketInfo = {
      id: Math.random().toString(36).substring(2, 8),
      targetIp,
      targetPort,
      protocol,
      nodeId: bestNode.id,
      nodeName: bestNode.name,
      nodeFlag: bestNode.flag,
      countryName: bestNode.countryName,
      startTime: new Date().toISOString(),
      startTimestamp: Date.now()
    };

    this.stats.activeSockets.unshift(socketInfo);
    if (this.stats.activeSockets.length > 30) {
      this.stats.activeSockets.pop();
    }

    return {
      node: bestNode,
      mode: this.mode,
      reason: `Routed to lowest RTT node (${bestNode.name} - ${bestNode.ping}ms)`
    };
  }

  // Get nodes grouped by country with per-country aggregated metrics & ordering
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
          activeConnectionsCount: 0
        };
      }
      groups[country].nodes.push(node);
      groups[country].totalPing += (node.ping || 0);
      groups[country].activeConnectionsCount += (activeNodeConnCounts[node.id] || 0);
    }

    const groupList = Object.values(groups).map(g => ({
      ...g,
      nodesCount: g.nodes.length,
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
