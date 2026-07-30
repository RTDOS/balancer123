let ws = null;
let telemetryChart = null;
let currentNodesMap = new Map();
let currentGroupedCountries = [];
let activeTelemetryRange = '15m';
let hasAdminPassword = false;
let currentAdminUsername = 'admin';
let currentInboundsList = [];
let isAuthenticatedSession = false;
let currentClusterKey = '';

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectWebSocket();
  fetchInitialStatus();

  setInterval(tickSocketUptimes, 1000);
});

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTargetName(ip) {
  if (!ip) return 'SOCKS/HTTP';
  if (ip.startsWith('149.154.') || ip.startsWith('91.108.')) {
    return `✈️ Telegram DC (${ip})`;
  }
  if (ip.startsWith('142.250.') || ip.startsWith('172.217.') || ip.startsWith('172.253.')) {
    return `🌐 Google/YouTube (${ip})`;
  }
  return ip;
}

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
        isAuthenticatedSession = !!data.authenticated;

        // MANDATORY CHECK: If not logged in, force open Login Modal!
        if (!isAuthenticatedSession) {
          document.getElementById('loginModal').classList.add('open');
          return;
        }

        if (data.clusterKey) {
          currentClusterKey = data.clusterKey;
          renderClusterKeyUI(currentClusterKey);
        }

        if (data.inbounds) {
          currentInboundsList = data.inbounds;
          renderNavbarInboundsBadge(currentInboundsList);
        }
        if (data.secretPath) {
          document.getElementById('secretPathBadge').innerText = `/${data.secretPath}/`;
        }
        hasAdminPassword = !!data.hasPassword;
        currentAdminUsername = data.adminUsername || 'admin';
        toggleDefaultPassBanner(data.isDefaultPassword);
        updateModeUI(data.mode);
      }
    });
}

function renderClusterKeyUI(key) {
  const keyEl = document.getElementById('clusterKeyDisplay');
  if (keyEl) {
    keyEl.innerText = key || 'Не сгенерирован';
  }
}

function copyClusterKey() {
  if (!currentClusterKey) {
    alert('Ключ кластера не сгенерирован.');
    return;
  }
  fallbackCopyText(currentClusterKey);
}

function regenerateClusterKeyDirect() {
  if (!confirm('Вы уверены, что хотите перегенерировать SHA-256 Ключ Кластера? Подключенные узлы потребуется перепривязать с новым ключом.')) return;

  fetch('/api/cluster/regenerate-key', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.success && data.clusterKey) {
        currentClusterKey = data.clusterKey;
        renderClusterKeyUI(currentClusterKey);
        alert('Новый SHA-256 Ключ Кластера успешно сгенерирован!');
      }
    });
}

function toggleDefaultPassBanner(isDefault) {
  const banner = document.getElementById('defaultPassWarningBanner');
  if (banner) {
    banner.style.display = isDefault ? 'flex' : 'none';
  }
}

function renderNavbarInboundsBadge(inbounds) {
  const socksInb = inbounds.find(i => i.type === 'socks5');
  const httpInb = inbounds.find(i => i.type === 'http');

  const socksText = socksInb ? `SOCKS5: ${socksInb.port}` : 'SOCKS5: Off';
  const httpText = httpInb ? `HTTP: ${httpInb.port}` : 'HTTP: Off';

  document.getElementById('socksPortDisplay').innerText = socksText;
  document.getElementById('httpPortDisplay').innerText = httpText;
}

function renderState(data) {
  updateModeUI(data.mode);

  if (data.clusterKey) {
    currentClusterKey = data.clusterKey;
    renderClusterKeyUI(currentClusterKey);
  }

  if (data.secretPath) {
    document.getElementById('secretPathBadge').innerText = `/${data.secretPath}/`;
  }

  if (data.inbounds) {
    currentInboundsList = data.inbounds;
    renderNavbarInboundsBadge(currentInboundsList);
  }

  hasAdminPassword = !!data.hasPassword;
  currentAdminUsername = data.adminUsername || 'admin';
  toggleDefaultPassBanner(data.isDefaultPassword);

  const nodes = data.nodes || [];
  document.getElementById('nodeCount').innerText = nodes.length;
  document.getElementById('preventedLags').innerText = data.stats.microLagPreventedCount || 0;
  document.getElementById('totalConnections').innerText = data.stats.totalRoutedConnections || 0;

  const activeSockCount = data.stats.activeSocketsCount || (data.stats.activeSockets ? data.stats.activeSockets.length : 0);
  const activeSockEl = document.getElementById('activeSocketsCount');
  if (activeSockEl) {
    activeSockEl.innerText = activeSockCount;
  }

  const totalDown = formatBytes(data.stats.totalBytesDownloaded || 0);
  const totalUp = formatBytes(data.stats.totalBytesUploaded || 0);
  const totalTrafficEl = document.getElementById('totalTrafficDisplay');
  if (totalTrafficEl) {
    totalTrafficEl.innerText = `⬇️ ${totalDown} | ⬆️ ${totalUp}`;
  }

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
          <span class="country-stat-badge" style="background:rgba(255,255,255,0.08); color:#9ca3af;">🌐 Узлов: ${group.nodesCount} | Серверов: ${group.serversCount || 1}</span>
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

      const serverGroupLabel = node.serverGroup ? `<span style="font-size:10px; background:rgba(99,102,241,0.2); color:#a5b4fc; padding:2px 6px; border-radius:4px; margin-left:6px;">🖥️ ${node.serverGroup}</span>` : '';

      card.innerHTML = `
        <div class="node-top">
          <div class="node-title-group">
            <span class="node-flag">${node.flag}</span>
            <div>
              <div class="node-name">${node.name} ${serverGroupLabel}</div>
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
            <button class="node-action-btn" onclick="openEditNodeModal('${node.id}')" title="Редактировать группу/сервер/страну">✏️</button>
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
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#9ca3af;">Ожидание подключений...</td></tr>`;
    return;
  }

  tbody.innerHTML = sockets.map(s => {
    const uptimeStr = formatDuration(Date.now() - (s.startTimestamp || Date.now()));
    const downStr = formatBytes(s.bytesRead || 0);
    const upStr = formatBytes(s.bytesWritten || 0);
    const targetText = formatTargetName(s.targetIp || s.user);

    return `
      <tr>
        <td><strong>${targetText}</strong></td>
        <td>${s.targetPort}</td>
        <td><span class="node-protocol">${s.protocol}</span></td>
        <td>${s.nodeFlag} ${s.nodeName}</td>
        <td>${s.nodeFlag} ${s.countryName || 'Auto'}</td>
        <td><span style="font-family:'JetBrains Mono', monospace; font-size:12px; color:#38bdf8;">⬇️ ${downStr}</span> | <span style="font-family:'JetBrains Mono', monospace; font-size:12px; color:#a5b4fc;">⬆️ ${upStr}</span></td>
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
        Этот сервер работает автономно. Скопируйте **SHA-256 Ключ Кластера** и привяжите 2-3 дополнительных сервера для автоматической P2P-синхронизации, сокетов и журнала подключений.
      </div>
    `;
    return;
  }

  container.innerHTML = peers.map(p => `
    <div class="peer-card">
      <div>
        <div class="peer-url">🌐 ${p.url} <span style="font-size:11px; color:#38bdf8; margin-left:6px;">(Key: ${p.clusterKey || 'SHA-256'})</span></div>
        <div style="font-size:11px; color:#9ca3af; margin-top:2px;">
          Узлов: ${p.nodeCount || 0} | Прокси: ${p.inboundsCount || 0} | Сокетов: ${p.activeSocketsCount || 0} | Синхр: ${p.lastSyncTime || 'Запуск...'}
        </div>
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

// --- TELEGRAM PROXY EXPORT LOGIC ---

function openTelegramExportModal() {
  const selectEl = document.getElementById('tgInboundSelect');
  selectEl.innerHTML = '';

  const socksInbounds = currentInboundsList.filter(i => i.type === 'socks5');
  const targetList = socksInbounds.length > 0 ? socksInbounds : currentInboundsList;

  if (targetList.length === 0) {
    selectEl.innerHTML = `<option value="">Нет активных SOCKS5 подключений</option>`;
  } else {
    targetList.forEach(inb => {
      selectEl.innerHTML += `<option value="${inb.id}">SOCKS5 Proxy (${inb.name}) - Port: ${inb.port}</option>`;
    });
  }

  const hostInput = document.getElementById('tgServerHostInput');
  if (!hostInput.value) {
    hostInput.value = window.location.hostname || 'localhost';
  }

  updateTelegramProxyPreview();
  document.getElementById('telegramExportModal').classList.add('open');
}

function closeTelegramExportModal() {
  document.getElementById('telegramExportModal').classList.remove('open');
}

function updateTelegramProxyPreview() {
  const selectedId = document.getElementById('tgInboundSelect').value;
  const serverHost = document.getElementById('tgServerHostInput').value.trim() || window.location.hostname || 'localhost';

  const inb = currentInboundsList.find(i => i.id === selectedId) || currentInboundsList[0];

  if (!inb) {
    document.getElementById('tgSocksLinkPreview').innerText = 'Нет данных';
    document.getElementById('tgAppSocksLinkPreview').innerText = 'Нет данных';
    document.getElementById('tgProxyLinkPreview').innerText = 'Нет данных';
    return;
  }

  const port = inb.port || 1080;
  const user = inb.username ? encodeURIComponent(inb.username) : '';
  const pass = inb.password ? encodeURIComponent(inb.password) : '';

  let queryParams = `server=${encodeURIComponent(serverHost)}&port=${port}`;
  if (user && pass) {
    queryParams += `&user=${user}&pass=${pass}`;
  }

  const tgSocksUrl = `https://t.me/socks?${queryParams}`;
  const tgAppSocksUrl = `tg://socks?${queryParams}`;
  const tmeProxyUrl = `https://t.me/proxy?${queryParams}`;

  document.getElementById('tgSocksLinkPreview').innerText = tgSocksUrl;
  document.getElementById('tgAppSocksLinkPreview').innerText = tgAppSocksUrl;
  document.getElementById('tgProxyLinkPreview').innerText = tmeProxyUrl;
}

function copyTelegramProxyLink(elementId) {
  copyProxyString(elementId);
}

// --- INTERACTIVE INBOUND PROXY CONFIGURATION LOGIC ---

function openInboundsConfigModal() {
  fetch('/api/inbounds')
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        currentInboundsList = data.inbounds;
        renderInboundsConfigCards(currentInboundsList);
        document.getElementById('inboundsConfigModal').classList.add('open');
      }
    });
}

function closeInboundsConfigModal() {
  document.getElementById('inboundsConfigModal').classList.remove('open');
}

function renderInboundsConfigCards(inbounds) {
  const container = document.getElementById('inboundsListContainer');
  container.innerHTML = '';

  const host = window.location.hostname || 'localhost';

  inbounds.forEach((inb) => {
    const card = document.createElement('div');
    card.className = 'inbound-card';
    card.id = `inboundCard_${inb.id}`;

    const initialUser = inb.username || '';
    const initialPass = inb.password || '';
    const initialPort = inb.port || 1080;
    const initialType = inb.type || 'socks5';

    let liveUrl = inb.connectionUrl || '';
    if (initialType === 'vless') {
      const uuid = initialUser || '93a8b412-402a-4361-8255-7389ef121111';
      liveUrl = `vless://${uuid}@${host}:${initialPort}?type=tcp#AntiLag_VLESS_${initialPort}`;
    } else if (initialType === 'tuic') {
      const uuid = initialUser || '93a8b412-402a-4361-8255-7389ef121111';
      const tuicPass = initialPass || 'tuicpass123';
      liveUrl = `tuic://${uuid}:${tuicPass}@${host}:${initialPort}?congestion_control=bbr&alpn=h3#AntiLag_TUIC_${initialPort}`;
    } else {
      const authPart = (initialUser && initialPass) ? `${initialUser}:${initialPass}@` : '';
      liveUrl = `${initialType}://${authPart}${host}:${initialPort}`;
    }

    card.innerHTML = `
      <div class="inbound-card-header">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="inbound-badge ${initialType}">${initialType.toUpperCase()}</span>
          <strong style="font-size:14px;">${inb.name}</strong>
        </div>
        <button class="delete-node-btn" onclick="deleteInboundProxy('${inb.id}')" title="Удалить этот прокси порт">🗑️</button>
      </div>

      <div class="form-row" style="display:flex; gap:10px;">
        <div style="flex:1;">
          <label style="font-size:12px;">Протокол</label>
          <select id="inbType_${inb.id}" class="form-input" onchange="updateInboundPreview('${inb.id}')">
            <option value="socks5" ${initialType === 'socks5' ? 'selected' : ''}>SOCKS5</option>
            <option value="http" ${initialType === 'http' ? 'selected' : ''}>HTTP</option>
            <option value="vless" ${initialType === 'vless' ? 'selected' : ''}>⚡ VLESS</option>
            <option value="tuic" ${initialType === 'tuic' ? 'selected' : ''}>🚀 TUIC v5</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="font-size:12px;">Порт (открывается в фаерволе)</label>
          <input type="number" id="inbPort_${inb.id}" class="form-input" value="${initialPort}" oninput="updateInboundPreview('${inb.id}')">
        </div>
      </div>

      <div class="form-row" style="display:flex; gap:10px;">
        <div style="flex:1;">
          <label style="font-size:12px;" id="inbUserLabel_${inb.id}">${initialType === 'vless' || initialType === 'tuic' ? 'UUID Клиента' : 'Логин (Username)'}</label>
          <div style="display:flex; gap:6px;">
            <input type="text" id="inbUser_${inb.id}" class="form-input" value="${initialUser}" placeholder="${initialType === 'vless' || initialType === 'tuic' ? '93a8b412-402a-4361-8255-7389ef121111' : 'без пароля'}" oninput="updateInboundPreview('${inb.id}')">
            <button class="btn btn-secondary btn-sm" type="button" onclick="generateInboundUserDirect('${inb.id}')" title="Сгенерировать">🎲</button>
          </div>
        </div>
        <div style="flex:1;" id="inbPassGroup_${inb.id}">
          <label style="font-size:12px;">${initialType === 'tuic' ? 'Пароль TUIC' : 'Пароль (Password)'}</label>
          <div style="display:flex; gap:6px;">
            <input type="text" id="inbPass_${inb.id}" class="form-input" value="${initialPass}" placeholder="${initialType === 'vless' ? 'не требуется для VLESS' : 'без пароля'}" ${initialType === 'vless' ? 'disabled' : ''} style="font-family:'JetBrains Mono', monospace;" oninput="updateInboundPreview('${inb.id}')">
            <button class="btn btn-secondary btn-sm" type="button" onclick="generateInboundPassDirect('${inb.id}')" title="Сгенерировать пароль">🎲</button>
          </div>
        </div>
      </div>

      <!-- Live Dynamic Connection String Preview Box -->
      <div>
        <label style="font-size:11px; color:#9ca3af;">Динамическая ссылка подключения (Live Connection String):</label>
        <div class="inbound-preview-box">
          <span id="inbPreview_${inb.id}">${liveUrl}</span>
          <button class="btn btn-secondary btn-sm" type="button" onclick="copyProxyString('inbPreview_${inb.id}')" style="padding:4px 8px; font-size:11px;">📋 Скопировать</button>
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
        <button class="btn btn-primary btn-sm" onclick="saveInboundProxy('${inb.id}')">💾 Сохранить изменения</button>
      </div>
    `;

    container.appendChild(card);
  });
}

function updateInboundPreview(id) {
  const host = window.location.hostname || 'localhost';
  const type = document.getElementById(`inbType_${id}`).value;
  const port = document.getElementById(`inbPort_${id}`).value || 1080;
  const user = document.getElementById(`inbUser_${id}`).value.trim();
  const pass = document.getElementById(`inbPass_${id}`).value.trim();

  const userLabel = document.getElementById(`inbUserLabel_${id}`);
  const passGroup = document.getElementById(`inbPassGroup_${id}`);
  const passInput = document.getElementById(`inbPass_${id}`);

  let liveUrl = '';
  if (type === 'vless') {
    if (userLabel) userLabel.innerText = 'UUID Клиента';
    if (passGroup) passGroup.style.opacity = '0.4';
    if (passInput) {
      passInput.placeholder = 'не требуется для VLESS';
      passInput.disabled = true;
    }
    const uuid = user || '93a8b412-402a-4361-8255-7389ef121111';
    liveUrl = `vless://${uuid}@${host}:${port}?type=tcp#AntiLag_VLESS_${port}`;
  } else if (type === 'tuic') {
    if (userLabel) userLabel.innerText = 'UUID Клиента';
    if (passGroup) passGroup.style.opacity = '1.0';
    if (passInput) {
      passInput.placeholder = 'Пароль TUIC';
      passInput.disabled = false;
    }
    const uuid = user || '93a8b412-402a-4361-8255-7389ef121111';
    const tuicPass = pass || 'tuicpass123';
    liveUrl = `tuic://${uuid}:${tuicPass}@${host}:${port}?congestion_control=bbr&alpn=h3#AntiLag_TUIC_${port}`;
  } else {
    if (userLabel) userLabel.innerText = 'Логин (Username)';
    if (passGroup) passGroup.style.opacity = '1.0';
    if (passInput) {
      passInput.placeholder = 'без пароля';
      passInput.disabled = false;
    }
    const authPart = (user && pass) ? `${user}:${pass}@` : '';
    liveUrl = `${type}://${authPart}${host}:${port}`;
  }

  const previewEl = document.getElementById(`inbPreview_${id}`);
  if (previewEl) {
    previewEl.innerText = liveUrl;
  }
}

function generateInboundUserDirect(id) {
  const typeEl = document.getElementById(`inbType_${id}`);
  const type = typeEl ? typeEl.value : 'socks5';

  if (type === 'vless' || type === 'tuic') {
    fetch('/api/generate-uuid')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.uuid) {
          const userInput = document.getElementById(`inbUser_${id}`);
          userInput.value = data.uuid;
          updateInboundPreview(id);
        }
      });
  } else {
    fetch('/api/generate-username')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.username) {
          const userInput = document.getElementById(`inbUser_${id}`);
          userInput.value = data.username;
          updateInboundPreview(id);
        }
      });
  }
}

function generateInboundPassDirect(id) {
  fetch('/api/generate-password')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.password) {
        const passInput = document.getElementById(`inbPass_${id}`);
        passInput.value = data.password;
        updateInboundPreview(id);
      }
    });
}

function generateNewInboundUsernameDirect() {
  const typeEl = document.getElementById('newInboundType');
  const type = typeEl ? typeEl.value : 'socks5';

  if (type === 'vless' || type === 'tuic') {
    fetch('/api/generate-uuid')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.uuid) {
          document.getElementById('newInboundUser').value = data.uuid;
        }
      });
  } else {
    fetch('/api/generate-username')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.username) {
          document.getElementById('newInboundUser').value = data.username;
        }
      });
  }
}

function generateNewInboundPasswordDirect() {
  fetch('/api/generate-password')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.password) {
        document.getElementById('newInboundPass').value = data.password;
      }
    });
}

function copyProxyString(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.innerText || el.textContent;

  fallbackCopyText(text);
}

function fallbackCopyText(text) {
  const temp = document.createElement('textarea');
  temp.value = text;
  document.body.appendChild(temp);
  temp.select();
  document.execCommand('copy');
  document.body.removeChild(temp);
  alert(`Скопировано в буфер обмена: ${text}`);
}

function saveInboundProxy(id) {
  const type = document.getElementById(`inbType_${id}`).value;
  const port = document.getElementById(`inbPort_${id}`).value;
  const username = document.getElementById(`inbUser_${id}`).value;
  const password = document.getElementById(`inbPass_${id}`).value;

  fetch(`/api/inbounds/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, port, username, password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        currentInboundsList = data.inbounds;
        renderNavbarInboundsBadge(currentInboundsList);
        renderInboundsConfigCards(currentInboundsList);
        alert('Прокси подключение успешно обновлено и открыто в фаерволе!');
      } else {
        alert(data.message || 'Ошибка обновления прокси');
      }
    });
}

function deleteInboundProxy(id) {
  if (!confirm('Вы уверены, что хотите удалить этот прокси порт?')) return;

  fetch(`/api/inbounds/${id}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        currentInboundsList = data.inbounds;
        renderNavbarInboundsBadge(currentInboundsList);
        renderInboundsConfigCards(currentInboundsList);
      } else {
        alert(data.message || 'Нельзя удалить данный прокси');
      }
    });
}

function openAddInboundModal() {
  document.getElementById('addInboundModal').classList.add('open');
}

function closeAddInboundModal() {
  document.getElementById('addInboundModal').classList.remove('open');
}

function submitAddInbound() {
  const type = document.getElementById('newInboundType').value;
  const port = document.getElementById('newInboundPort').value;
  const username = document.getElementById('newInboundUser').value;
  const password = document.getElementById('newInboundPass').value;

  fetch('/api/inbounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, port, username, password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        closeAddInboundModal();
        currentInboundsList = data.inbounds;
        renderNavbarInboundsBadge(currentInboundsList);
        renderInboundsConfigCards(currentInboundsList);
      } else {
        alert(data.message || 'Ошибка создания прокси');
      }
    });
}

// --- MANDATORY AUTH & LOGIN LOGIC ---

function submitLogin() {
  const username = document.getElementById('loginUsernameInput').value;
  const password = document.getElementById('loginPasswordInput').value;
  const errorEl = document.getElementById('loginErrorMsg');

  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        document.getElementById('loginModal').classList.remove('open');
        
        // MANDATORY: If first login with default password (admin), force password change!
        if (data.isDefaultPassword) {
          document.getElementById('forceChangePassModal').classList.add('open');
        } else {
          window.location.reload();
        }
      } else {
        errorEl.innerText = data.message || 'Ошибка авторизации';
        errorEl.style.display = 'block';
      }
    });
}

function generateForcePasswordDirect() {
  fetch('/api/generate-password')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.password) {
        const input = document.getElementById('forcePasswordInput');
        input.value = data.password;
      }
    });
}

function submitForceChangePassword() {
  const username = document.getElementById('forceUsernameInput').value;
  const password = document.getElementById('forcePasswordInput').value;

  if (!password || password.trim() === 'admin') {
    alert('Пароль не может быть "admin"! Придумайте или сгенерируйте свой пароль.');
    return;
  }

  fetch('/api/settings/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        document.getElementById('forceChangePassModal').classList.remove('open');
        // Auto insert new username and password directly into the login form inputs!
        document.getElementById('loginUsernameInput').value = username;
        document.getElementById('loginPasswordInput').value = password;
        document.getElementById('loginModal').classList.add('open');
        
        // Auto-submit login form so Chrome triggers "Save password to Google Chrome"!
        submitLogin();
      }
    });
}

function openAdminAuthModal() {
  document.getElementById('adminUsernameInput').value = currentAdminUsername;
  document.getElementById('adminPasswordInput').value = '';
  document.getElementById('adminAuthModal').classList.add('open');
}

function closeAdminAuthModal() {
  document.getElementById('adminAuthModal').classList.remove('open');
}

function generateAdminPasswordDirect() {
  fetch('/api/generate-password')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.password) {
        const input = document.getElementById('adminPasswordInput');
        input.value = data.password;
        input.type = 'text';
        input.select();
      }
    });
}

function submitAdminAuth() {
  const username = document.getElementById('adminUsernameInput').value;
  const password = document.getElementById('adminPasswordInput').value;

  fetch('/api/settings/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) {
        closeAdminAuthModal();
        // Auto insert new username and password directly into the login form inputs!
        document.getElementById('loginUsernameInput').value = username;
        document.getElementById('loginPasswordInput').value = password;
        document.getElementById('loginModal').classList.add('open');
        
        // Auto-submit login form so Chrome triggers "Save password to Google Chrome"!
        submitLogin();
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

function generateSecretPathDirect() {
  fetch('/api/generate-secret-path')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.secretPath) {
        document.getElementById('secretPathInput').value = data.secretPath;
      }
    });
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
        alert(`Секретный путь успешно изменен! Перенаправляем на новое место: /${data.secretPath}/`);
        window.location.href = `/${data.secretPath}/`;
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
  const clusterKey = document.getElementById('peerClusterKeyInput').value;
  if (!peerUrl.trim()) return;

  fetch('/api/cluster/peers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerUrl, clusterKey })
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
  document.getElementById('editServerGroup').value = node.serverGroup || node.address || '';
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
  const serverGroup = document.getElementById('editServerGroup').value;
  const countryName = document.getElementById('editCountryName').value;
  const countryCode = document.getElementById('editCountryCode').value;
  const flag = document.getElementById('editNodeFlag').value;

  fetch(`/api/nodes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, serverGroup, countryName, countryCode, flag })
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
  const host = window.location.hostname || 'localhost';
  const port = window.location.port ? `:${window.location.port}` : '';
  const proto = window.location.protocol;

  const universalSubUrl = `${proto}//${host}${port}/api/export/sub`;
  const clashSubUrl = `${proto}//${host}${port}/api/export/clash`;

  const uniInput = document.getElementById('universalSubUrlInput');
  if (uniInput) uniInput.value = universalSubUrl;

  const clashInput = document.getElementById('clashSubUrlInput');
  if (clashInput) clashInput.value = clashSubUrl;

  const exportText = currentInboundsList.map(inb => {
    const auth = (inb.username && inb.password) ? `${inb.username}:${inb.password}@` : '';
    return `${inb.type}://${auth}${host}:${inb.port}`;
  }).join('\n');

  const area = document.getElementById('clientSocksExportArea');
  if (area) {
    area.value = exportText || 'Нет настроенных входящих прокси';
  }
  
  const activeNodes = Array.from(currentNodesMap.values());
  const links = activeNodes.map(n => n.raw).join('\n\n');
  document.getElementById('exportTextarea').value = links || 'Нет активных VPN серверов';

  document.getElementById('exportModal').classList.add('open');
}

function closeExportModal() {
  document.getElementById('exportModal').classList.remove('open');
}

function copyProxyString(elementId) {
  const input = document.getElementById(elementId);
  if (!input) return;

  const textToCopy = input.value || input.innerText;
  
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      alert('📋 Ссылка подписки скопирована в буфер обмена!');
    }).catch(() => {
      fallbackCopyText(input);
    });
  } else {
    fallbackCopyText(input);
  }
}

function fallbackCopyText(input) {
  if (!input) return;
  input.focus();
  input.select();
  if (input.setSelectionRange) {
    input.setSelectionRange(0, 99999);
  }
  try {
    const successful = document.execCommand('copy');
    if (successful) {
      alert('📋 Скопировано в буфер обмена!');
    } else {
      prompt('Скопируйте ссылку вручную:', input.value);
    }
  } catch (err) {
    prompt('Скопируйте ссылку вручную:', input.value);
  }
}

function copyClientSocksProxies() {
  const area = document.getElementById('clientSocksExportArea');
  fallbackCopyText(area);
}

function copyExportLinks() {
  const textarea = document.getElementById('exportTextarea');
  fallbackCopyText(textarea);
}

function pingAllNodes() {
  fetch('/api/simulate-lag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetIp: '8.8.8.8' })
  }).then(res => res.json())
    .then(() => alert('Проверка всех нод выполнена!'));
}
