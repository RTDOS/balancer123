let ws = null;
let telemetryChart = null;
let currentNodesMap = new Map();
let currentGroupedCountries = [];
let activeTelemetryRange = '15m';

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectWebSocket();
  fetchInitialStatus();

  setInterval(tickSocketUptimes, 1000);
});

// Initialize Chart.js
function initChart() {
  const ctx = document.getElementById('telemetryChart').getContext('2d');
  telemetryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Средний Пинг (мс)',
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          fill: true,
          tension: 0.4
        },
        {
          label: 'Потери пакетов (%)',
          data: [],
          borderColor: '#ef4444',
          backgroundColor: 'transparent',
          borderDash: [5, 5],
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#9ca3af', font: { family: 'Outfit' } }
        }
      },
      scales: {
        x: {
          ticks: { color: '#9ca3af' },
          grid: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        y: {
          ticks: { color: '#9ca3af' },
          grid: { color: 'rgba(255, 255, 255, 0.05)' }
        }
      }
    }
  });
}

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'INIT' || msg.type === 'TELEMETRY') {
        renderState(msg.data);
      }
    } catch (e) {
      console.error('WS Parse Error', e);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2000);
  };
}

function fetchInitialStatus() {
  fetch('/api/status')
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        document.getElementById('socksPort').innerText = data.inbounds.socks5;
        document.getElementById('httpPort').innerText = data.inbounds.http;
        if (data.secretPath) {
          document.getElementById('secretPathBadge').innerText = `/${data.secretPath}/`;
        }
        updateModeUI(data.mode);
      }
    });
}

function renderState(data) {
  updateModeUI(data.mode);

  if (data.secretPath) {
    document.getElementById('secretPathBadge').innerText = `/${data.secretPath}/`;
  }

  const nodes = data.nodes || [];
  document.getElementById('nodeCount').innerText = nodes.length;
  document.getElementById('preventedLags').innerText = data.stats.microLagPreventedCount || 0;
  document.getElementById('totalConnections').innerText = data.stats.totalRoutedConnections || 0;
  document.getElementById('activeSocketsCount').innerText = data.stats.activeSocketsCount || (data.stats.activeSockets ? data.stats.activeSockets.length : 0);

  // Cache nodes and country groups
  currentNodesMap.clear();
  nodes.forEach(n => currentNodesMap.set(n.id, n));
  currentGroupedCountries = data.grouped || [];

  let avgPing = 0;
  if (nodes.length > 0) {
    const sum = nodes.reduce((acc, n) => acc + (n.ping || 0), 0);
    avgPing = Math.round(sum / nodes.length);
  }
  document.getElementById('avgPing').innerText = `${avgPing} ms`;

  renderGroupedNodes(currentGroupedCountries);
  renderSocketsTable(data.stats.activeSockets || []);
  renderClusterPeers(data.cluster || {});

  if (data.overallHistory && telemetryChart) {
    updateChartData(data.overallHistory);
  }
}

function updateChartData(historyData) {
  const labels = historyData.map(h => h.timestamp);
  const pings = historyData.map(h => h.avgPing);
  const losses = historyData.map(h => h.avgLoss);

  telemetryChart.data.labels = labels;
  telemetryChart.data.datasets[0].data = pings;
  telemetryChart.data.datasets[1].data = losses;
  telemetryChart.update('none');
}

function setTelemetryRange(range) {
  activeTelemetryRange = range;
  document.querySelectorAll('.tf-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`tf${range}`);
  if (activeBtn) activeBtn.classList.add('active');

  fetch(`/api/telemetry?range=${range}`)
    .then(res => res.json())
    .then(data => {
      if (data.success && data.telemetry) {
        updateChartData(data.telemetry);
      }
    });
}

function updateModeUI(mode) {
  const gamingBtn = document.getElementById('modeGamingBtn');
  const webBtn = document.getElementById('modeWebBtn');

  if (mode === 'gaming') {
    gamingBtn.classList.add('active');
    webBtn.classList.remove('active');
  } else {
    webBtn.classList.add('active');
    gamingBtn.classList.remove('active');
  }
}

function setMode(mode) {
  fetch('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        updateModeUI(data.mode);
      }
    });
}

function renderGroupedNodes(grouped) {
  const container = document.getElementById('nodesContainer');
  container.innerHTML = '';

  let totalCountries = grouped.length;
  document.getElementById('countryCountBadge').innerText = `${totalCountries} стран`;

  grouped.forEach((group, index) => {
    const groupHeader = document.createElement('div');
    groupHeader.className = 'node-group-header';

    const isFirst = index === 0;
    const isLast = index === grouped.length - 1;

    groupHeader.innerHTML = `
      <div class="node-group-left">
        <div class="node-group-title-text">
          <span>${group.flag}</span>
          <span>${group.countryName}</span>
        </div>
        <div class="country-stats">
          <span class="country-stat-badge">⚡ Ср. пинг: ${group.avgPing} ms</span>
          <span class="country-stat-badge active-conns">🔀 Соединений: ${group.activeConnectionsCount}</span>
          <span class="country-stat-badge" style="background:rgba(255,255,255,0.08); color:#9ca3af;">🌐 Серверов: ${group.nodesCount}</span>
        </div>
      </div>
      <div class="move-group-btns">
        <button class="move-country-btn" onclick="moveCountry('${group.countryName}', 'up')" ${isFirst ? 'disabled style="opacity:0.3;"' : ''} title="Переместить вверх">▲</button>
        <button class="move-country-btn" onclick="moveCountry('${group.countryName}', 'down')" ${isLast ? 'disabled style="opacity:0.3;"' : ''} title="Переместить вниз">▼</button>
      </div>
    `;
    container.appendChild(groupHeader);

    group.nodes.forEach(node => {
      const card = document.createElement('div');
      card.className = `node-card ${node.status === 'active' ? '' : 'degraded'}`;

      let pingClass = 'ping-good';
      if (node.ping > 80) pingClass = 'ping-warn';
      if (node.ping > 200 || node.lossRatio > 10) pingClass = 'ping-bad';

      card.innerHTML = `
        <div class="node-top">
          <div class="node-title-group">
            <span class="node-flag">${node.flag}</span>
            <div>
              <div class="node-name">${node.name}</div>
              <div style="font-size:11px; color:#9ca3af; margin-top:2px;">${node.address}:${node.port}</div>
            </div>
          </div>
          <span class="node-protocol">${node.type}</span>
        </div>
        <div class="node-metrics">
          <div>Пинг: <strong class="${pingClass}">${node.ping} ms</strong></div>
          <div>Jitter: <strong>${node.jitter} ms</strong></div>
          <div>Потери: <strong>${node.lossRatio}%</strong></div>
        </div>
        <div class="node-footer">
          <span>Статус: <strong style="color:${node.status === 'active' ? '#10b981' : '#ef4444'}">${node.status.toUpperCase()}</strong></span>
          <div class="node-actions">
            <button class="node-action-btn" onclick="openEditNodeModal('${node.id}')" title="Редактировать страну/название">✏️</button>
            <button class="delete-node-btn" onclick="deleteNode('${node.id}')" title="Удалить узел">🗑️</button>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
  });
}

function moveCountry(countryName, direction) {
  fetch('/api/countries/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryName, direction })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        currentGroupedCountries = data.grouped;
        renderGroupedNodes(currentGroupedCountries);
      }
    });
}

function renderSocketsTable(sockets) {
  const tbody = document.getElementById('socketsTableBody');
  if (sockets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#9ca3af;">Ожидание подключений...</td></tr>`;
    return;
  }

  tbody.innerHTML = sockets.map(s => {
    const uptimeStr = formatDuration(Date.now() - (s.startTimestamp || Date.now()));
    return `
      <tr>
        <td>${s.targetIp}</td>
        <td>${s.targetPort}</td>
        <td><span class="node-protocol">${s.protocol}</span></td>
        <td>${s.nodeFlag} ${s.nodeName}</td>
        <td>${s.nodeFlag} ${s.countryName || 'Auto'}</td>
        <td><strong class="uptime-counter" data-start="${s.startTimestamp || Date.now()}">${uptimeStr}</strong></td>
        <td><span style="color:#10b981;">● Active (AntiLag)</span></td>
      </tr>
    `;
  }).join('');
}

function renderClusterPeers(clusterData) {
  const container = document.getElementById('clusterPeersContainer');
  const peers = clusterData.peers || [];

  if (peers.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; color:#9ca3af; font-size:13px; text-align:center; padding:12px;">
        Этот сервер работает автономно. Вы можете привязать 2-3 дополнительных сервера для автоматической P2P-синхронизации и отказоустойчивости.
      </div>
    `;
    return;
  }

  container.innerHTML = peers.map(p => `
    <div class="peer-card">
      <div>
        <div class="peer-url">🌐 ${p.url}</div>
        <div style="font-size:11px; color:#9ca3af; margin-top:2px;">Нод: ${p.nodeCount || 0} | Синхр: ${p.lastSyncTime || 'Запуск...'}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="${p.status === 'online' ? 'peer-status-online' : 'peer-status-offline'}">
          ● ${p.status.toUpperCase()}
        </span>
        <button class="delete-node-btn" onclick="deletePeer('${p.id}')" title="Удалить ноду из кластера">🗑️</button>
      </div>
    </div>
  `).join('');
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const h = Math.floor(m / 60);
  const minRest = m % 60;

  if (h > 0) return `${h}ч ${minRest}м ${s}с`;
  return `${minRest}м ${s}с`;
}

function tickSocketUptimes() {
  document.querySelectorAll('.uptime-counter').forEach(el => {
    const startMs = parseInt(el.getAttribute('data-start'));
    if (startMs) {
      el.innerText = formatDuration(Date.now() - startMs);
    }
  });
}

function openImportModal() {
  document.getElementById('importModal').classList.add('open');
}

function closeImportModal() {
  document.getElementById('importModal').classList.remove('open');
}

function onImportCountrySelectChange() {
  const val = document.getElementById('importCountrySelect').value;
  const customRow = document.getElementById('customImportCountryRow');
  if (val === 'CUSTOM') {
    customRow.style.display = 'flex';
  } else {
    customRow.style.display = 'none';
  }
}

function submitParseLinks() {
  const text = document.getElementById('importTextarea').value;
  if (!text.trim()) return;

  let countryPayload = {};
  const selectVal = document.getElementById('importCountrySelect').value;

  if (selectVal === 'CUSTOM') {
    countryPayload = {
      countryName: document.getElementById('importCustomCountryName').value || 'Custom Country',
      countryCode: document.getElementById('importCustomCountryCode').value || 'CC',
      flag: document.getElementById('importCustomFlag').value || '🌐'
    };
  } else if (selectVal !== 'AUTO') {
    const [code, countryName, flag] = selectVal.split('|');
    countryPayload = { countryCode: code, countryName, flag };
  }

  fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...countryPayload })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        document.getElementById('importTextarea').value = '';
        closeImportModal();
      } else {
        alert(data.message || 'Ошибка парсинга ссылок');
      }
    });
}

function openSecretSettingsModal() {
  document.getElementById('secretSettingsModal').classList.add('open');
}

function closeSecretSettingsModal() {
  document.getElementById('secretSettingsModal').classList.remove('open');
}

function submitSecretPath() {
  const secretPath = document.getElementById('secretPathInput').value;
  if (!secretPath.trim()) return;

  fetch('/api/settings/secret-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secretPath })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        closeSecretSettingsModal();
        alert(`Секретный путь изменен! Теперь панель доступна по адресу /${data.secretPath}/`);
      }
    });
}

function openAddPeerModal() {
  document.getElementById('addPeerModal').classList.add('open');
}

function closeAddPeerModal() {
  document.getElementById('addPeerModal').classList.remove('open');
}

function submitAddPeer() {
  const peerUrl = document.getElementById('peerUrlInput').value;
  const secret = document.getElementById('peerSecretInput').value;
  if (!peerUrl.trim()) return;

  fetch('/api/cluster/peers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerUrl, secret })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        closeAddPeerModal();
      } else {
        alert(data.message || 'Ошибка подключения узла кластера');
      }
    });
}

function deletePeer(peerId) {
  fetch(`/api/cluster/peers/${peerId}`, { method: 'DELETE' });
}

function openEditNodeModal(nodeId) {
  const node = currentNodesMap.get(nodeId);
  if (!node) return;

  document.getElementById('editNodeId').value = node.id;
  document.getElementById('editNodeName').value = node.name || '';
  document.getElementById('editCountryName').value = node.countryName || '';
  document.getElementById('editCountryCode').value = node.countryCode || '';
  document.getElementById('editNodeFlag').value = node.flag || '';

  const selectEl = document.getElementById('editPresetCountrySelect');
  selectEl.innerHTML = `<option value="">-- Выбрать из существующих стран --</option>`;

  currentGroupedCountries.forEach(g => {
    selectEl.innerHTML += `<option value="${g.countryCode}|${g.countryName}|${g.flag}">${g.flag} ${g.countryName} (${g.countryCode})</option>`;
  });

  document.getElementById('editNodeModal').classList.add('open');
}

function onEditPresetCountryChange() {
  const val = document.getElementById('editPresetCountrySelect').value;
  if (!val) return;

  const [code, countryName, flag] = val.split('|');
  document.getElementById('editCountryCode').value = code;
  document.getElementById('editCountryName').value = countryName;
  document.getElementById('editNodeFlag').value = flag;
}

function closeEditNodeModal() {
  document.getElementById('editNodeModal').classList.remove('open');
}

function submitEditNode() {
  const id = document.getElementById('editNodeId').value;
  const name = document.getElementById('editNodeName').value;
  const countryName = document.getElementById('editCountryName').value;
  const countryCode = document.getElementById('editCountryCode').value;
  const flag = document.getElementById('editNodeFlag').value;

  fetch(`/api/nodes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, countryName, countryCode, flag })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        closeEditNodeModal();
      } else {
        alert(data.message || 'Ошибка обновления узла');
      }
    });
}

function deleteNode(nodeId) {
  fetch(`/api/nodes/${nodeId}`, { method: 'DELETE' })
    .then(res => res.json());
}

function openModeInfoModal() {
  document.getElementById('modeInfoModal').classList.add('open');
}

function closeModeInfoModal() {
  document.getElementById('modeInfoModal').classList.remove('open');
}

function openExportModal() {
  const host = window.location.host;
  document.getElementById('clientSocksExport').value = `SOCKS5: ${host.split(':')[0]}:1080 | HTTP: ${host.split(':')[0]}:1081`;
  
  const activeNodes = Array.from(currentNodesMap.values());
  const links = activeNodes.map(n => n.raw).join('\n\n');
  document.getElementById('exportTextarea').value = links || 'Нет активных VPN серверов';

  document.getElementById('exportModal').classList.add('open');
}

function closeExportModal() {
  document.getElementById('exportModal').classList.remove('open');
}

function copyExportLinks() {
  const textarea = document.getElementById('exportTextarea');
  textarea.select();
  document.execCommand('copy');
  alert('Ссылки всех сбалансированных серверов скопированы!');
}

function pingAllNodes() {
  fetch('/api/simulate-lag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetIp: '8.8.8.8' })
  }).then(res => res.json())
    .then(() => alert('Проверка всех нод выполнена!'));
}
