const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns');

class RuBypassManager {
  constructor() {
    this.domainsSet = new Set();
    this.ipPrefixes = [
      '178.237.', '178.', '185.', '91.', '77.', '87.', '95.', '109.',
      '212.', '213.', '217.', '31.', '46.', '176.', '188.', '193.', '194.', '195.'
    ];
    this.cacheFile = path.join(__dirname, '..', 'data', 'ru_domains_cache.json');
    this.lastUpdated = null;
    this.isSyncing = false;

    this.initDefaultDomains();
    this.loadCache();
  }

  initDefaultDomains() {
    const defaults = [
      'ru', 'su', 'рф', 'by', 'ru.com', 'ru.net',
      'yandex.ru', 'ya.ru', 'yandex.net', 'yastatic.net', 'vk.com', 'vk.ru', 'vkontakte.ru',
      'mail.ru', 'ok.ru', 'gosuslugi.ru', 'sberbank.ru', 'sber.ru', 'tbank.ru', 'tinkoff.ru',
      'ozon.ru', 'ozon.cloud', 'ozon-images.ru', 'ozon.st', 'wildberries.ru', 'wb.ru', 'avito.ru',
      'rutube.ru', 'kinopoisk.ru', 'dzen.ru', 'rambler.ru', '2gis.ru', 'mos.ru', 'nspk.ru',
      'mirconnect.ru', 'gazprom.ru', 'vtb.ru', 'alfabank.ru', 'raiffeisen.ru', 'ria.ru', 'tass.ru',
      'rbc.ru', 'lenta.ru', 'habr.com', 'cyberleninka.ru', 'e-disclosure.ru'
    ];
    defaults.forEach(d => this.domainsSet.add(d.toLowerCase()));
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, 'utf-8');
        const data = JSON.parse(raw);
        if (data.domains && Array.isArray(data.domains)) {
          data.domains.forEach(d => this.domainsSet.add(d.toLowerCase()));
          this.lastUpdated = data.lastUpdated || null;
          console.log(`🇷🇺 [RuBypass] Loaded ${data.domains.length} RU bypass domains from disk cache.`);
        }
      }
    } catch (e) {
      console.error('Failed to load RuBypass disk cache:', e.message);
    }
  }

  saveCache(domainsList) {
    try {
      const dataDir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const payload = {
        lastUpdated: new Date().toISOString(),
        count: domainsList.length,
        domains: domainsList
      };
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload, null, 2), 'utf-8');
      this.lastUpdated = payload.lastUpdated;
    } catch (e) {
      console.error('Failed to save RuBypass disk cache:', e.message);
    }
  }

  isRuTarget(targetHost) {
    if (!targetHost || typeof targetHost !== 'string') return false;
    const host = targetHost.trim().toLowerCase();

    // 1. TLD check
    if (host.endsWith('.ru') || host.endsWith('.su') || host.endsWith('.рф') || host.endsWith('.by') || host.endsWith('.ru.com') || host.endsWith('.ru.net')) {
      return true;
    }

    // 2. Direct Set lookup or parent domain check
    if (this.domainsSet.has(host)) return true;

    const parts = host.split('.');
    if (parts.length >= 2) {
      const parentDomain = parts.slice(-2).join('.');
      if (this.domainsSet.has(parentDomain)) return true;
    }

    // 3. Keyword check
    for (const d of this.domainsSet) {
      if (d.includes('.') && (host === d || host.endsWith('.' + d) || host.includes(d))) {
        return true;
      }
    }

    // 4. Russian IP Subnets
    for (const prefix of this.ipPrefixes) {
      if (host.startsWith(prefix)) return true;
    }

    return false;
  }

  async syncWithGithub() {
    if (this.isSyncing) return { success: false, message: 'Синхронизация уже выполняется...' };
    this.isSyncing = true;

    const urls = [
      'https://cdn.jsdelivr.net/gh/v2fly/domain-list-community@master/data/category-ru',
      'https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/category-ru',
      'https://fastly.jsdelivr.net/gh/v2fly/domain-list-community@master/data/category-ru'
    ];

    let downloadedDomainsCount = 0;
    const newDomains = new Set();

    try {
      for (const url of urls) {
        try {
          const text = await this.fetchUrl(url);
          const lines = text.split('\n');
          for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('//')) continue;
            line = line.split('@')[0].trim();
            line = line.replace(/^(full:|domain:|keyword:|regexp:)/i, '').trim();
            if (line.includes('.')) {
              newDomains.add(line.toLowerCase());
              downloadedDomainsCount++;
            }
          }
        } catch (e) {
          console.warn(`[RuBypass Sync] Warning fetching ${url}:`, e.message);
        }
      }

      newDomains.forEach(d => this.domainsSet.add(d));
      const allDomainsArray = Array.from(this.domainsSet);
      this.saveCache(allDomainsArray);

      console.log(`✅ [RuBypass Sync] Downloaded ${downloadedDomainsCount} domains from GitHub. Total active database: ${allDomainsArray.length} domains.`);

      return {
        success: true,
        count: allDomainsArray.length,
        downloadedCount: downloadedDomainsCount,
        lastUpdated: this.lastUpdated
      };
    } finally {
      this.isSyncing = false;
    }
  }

  fetchUrl(url) {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      // Fast native curl / curl.exe execution (0.3s latency)
      exec(`curl.exe -sL "${url}" || curl -sL "${url}"`, { maxBuffer: 15 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (!err && stdout && stdout.length > 50) {
          return resolve(stdout);
        }
        // Fallback to https.get
        const client = url.startsWith('https') ? https : http;
        const options = {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AntiLag-Router/4.1.0' },
          timeout: 10000
        };
        const req = client.get(url, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return this.fetchUrl(res.headers.location).then(resolve).catch(reject);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout 10s'));
        });
      });
    });
  }

  getStats() {
    return {
      count: this.domainsSet.size,
      lastUpdated: this.lastUpdated,
      isSyncing: this.isSyncing
    };
  }
}

module.exports = RuBypassManager;
