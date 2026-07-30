const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CURRENT_VERSION = '4.1.0';

const DEFAULT_CONFIG = {
  version: CURRENT_VERSION,
  secretPath: 'secret',
  adminUsername: 'admin',
  adminPassword: 'admin',
  isDefaultPassword: true,
  clusterKey: '',
  mode: 'gaming',
  countryOrder: [],
  inbounds: [
    {
      id: 'default-socks5',
      name: 'Main SOCKS5 Proxy (1080)',
      type: 'socks5',
      port: 1080,
      username: '',
      password: ''
    },
    {
      id: 'default-http',
      name: 'Main HTTP Proxy (1081)',
      type: 'http',
      port: 1081,
      username: '',
      password: ''
    }
  ],
  nodes: [],
  clusterPeers: []
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed, version: CURRENT_VERSION };
    }
  } catch (e) {
    console.error('[Config Error] Failed to load config.json, using defaults:', e.message);
  }

  // Generate initial clusterKey if missing
  const initialConfig = {
    ...DEFAULT_CONFIG,
    clusterKey: crypto.randomBytes(32).toString('hex')
  };
  saveConfig(initialConfig);
  return initialConfig;
}

function saveConfig(configData) {
  try {
    const dataToWrite = {
      ...configData,
      version: CURRENT_VERSION
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(dataToWrite, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[Config Error] Failed to save config.json:', e.message);
    return false;
  }
}

module.exports = {
  CURRENT_VERSION,
  CONFIG_PATH,
  loadConfig,
  saveConfig
};
