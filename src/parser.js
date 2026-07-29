const crypto = require('crypto');

/**
 * Universal VPN / Proxy Link and Subscription Parser
 * Supports: VLESS, VMess, Shadowsocks, Trojan, Hysteria2, TUIC, WireGuard, NaiveProxy (naive+https://), Snell, Brook, SSR, SOCKS5, HTTP(S) and any compound URI.
 */

// Helper to decode Base64 safely
function safeBase64Decode(str) {
  try {
    let cleanStr = str.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (cleanStr.length % 4 !== 0) {
      cleanStr += '=';
    }
    return Buffer.from(cleanStr, 'base64').toString('utf-8');
  } catch (e) {
    return str;
  }
}

// Country Code to Flag Emoji helper
function countryCodeToFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  const c = code.toUpperCase();
  const first = 127397 + c.charCodeAt(0);
  const second = 127397 + c.charCodeAt(1);
  return String.fromCodePoint(first, second);
}

// Known preset countries list
const PRESET_COUNTRIES = [
  { code: 'DE', country: 'Germany', flag: '🇩🇪' },
  { code: 'NL', country: 'Netherlands', flag: '🇳🇱' },
  { code: 'US', country: 'United States', flag: '🇺🇸' },
  { code: 'FI', country: 'Finland', flag: '🇫🇮' },
  { code: 'SG', country: 'Singapore', flag: '🇸🇬' },
  { code: 'TR', country: 'Turkey', flag: '🇹🇷' },
  { code: 'PL', country: 'Poland', flag: '🇵🇱' },
  { code: 'GB', country: 'United Kingdom', flag: '🇬🇧' },
  { code: 'JP', country: 'Japan', flag: '🇯🇵' },
  { code: 'SE', country: 'Sweden', flag: '🇸🇪' },
  { code: 'RU', country: 'Russia', flag: '🇷🇺' }
];

// Simple GeoIP Country Resolver mock/lookup based on IP ranges / domain hints
function resolveGeoIP(address) {
  const lower = (address || '').toLowerCase();
  for (const item of PRESET_COUNTRIES) {
    if (lower.includes(item.code.toLowerCase()) || lower.includes(item.country.toLowerCase())) {
      return item;
    }
  }
  
  // Hash address for deterministic fallback demo assignment if unknown
  const charSum = address.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return PRESET_COUNTRIES[charSum % PRESET_COUNTRIES.length];
}

function parseSingleLink(rawUri, overrideCountry = null) {
  const uri = rawUri.trim();
  if (!uri) return null;

  const id = crypto.createHash('md5').update(uri).digest('hex').substring(0, 10);

  // VMess (Base64 JSON)
  if (uri.startsWith('vmess://')) {
    try {
      const b64 = uri.replace('vmess://', '');
      const jsonStr = safeBase64Decode(b64);
      const data = JSON.parse(jsonStr);
      const geo = overrideCountry || resolveGeoIP(data.add + ' ' + (data.ps || ''));

      return {
        id,
        name: data.ps || 'VMess Node',
        type: 'VMess',
        address: data.add || '127.0.0.1',
        port: parseInt(data.port) || 443,
        uuid: data.id,
        raw: uri,
        countryCode: geo.code,
        countryName: geo.country,
        flag: geo.flag,
        status: 'active',
        ping: Math.floor(Math.random() * 45) + 20,
        jitter: Math.floor(Math.random() * 8),
        lossRatio: 0
      };
    } catch (e) {
      // Fallback if not JSON
    }
  }

  // Universal URI regex parser for ANY scheme: scheme://[user:pass@]host:port[?query][#name]
  const uriMatch = uri.match(/^([a-zA-Z0-9\+\-\.]+):\/\/(?:([^@]+)@)?([^:\/\?#]+)(?::(\d+))?(?:[\/\?][^#]*)?(?:#(.*))?$/);

  if (uriMatch) {
    const rawScheme = uriMatch[1].toLowerCase();
    const userAuth = uriMatch[2] || '';
    const host = uriMatch[3];
    const portStr = uriMatch[4];
    const hashName = uriMatch[5] ? decodeURIComponent(uriMatch[5]) : '';

    // Determine clean protocol type
    let protoType = rawScheme.toUpperCase();
    if (rawScheme.startsWith('naive')) protoType = 'NaiveProxy';
    else if (rawScheme.startsWith('hysteria2') || rawScheme.startsWith('hy2')) protoType = 'Hysteria2';
    else if (rawScheme.startsWith('vless')) protoType = 'VLESS';
    else if (rawScheme.startsWith('trojan')) protoType = 'Trojan';
    else if (rawScheme.startsWith('ss')) protoType = 'Shadowsocks';
    else if (rawScheme.startsWith('tuic')) protoType = 'TUIC';
    else if (rawScheme.startsWith('wg') || rawScheme.startsWith('wireguard')) protoType = 'WireGuard';

    // Auto default port if missing
    let port = parseInt(portStr);
    if (!port) {
      if (rawScheme.includes('https') || rawScheme === 'vless' || rawScheme === 'trojan' || rawScheme === 'hysteria2') port = 443;
      else if (rawScheme === 'socks5') port = 1080;
      else port = 80;
    }

    // Name construction
    let name = hashName;
    if (!name) {
      const userPart = userAuth.length > 8 ? userAuth.substring(0, 8) + '...' : userAuth;
      name = userPart ? `${userPart}@${host}` : `${protoType} ${host}`;
    }

    const geo = overrideCountry || resolveGeoIP(host + ' ' + name);

    return {
      id,
      name,
      type: protoType,
      address: host,
      port,
      raw: uri,
      countryCode: geo.code,
      countryName: geo.country,
      flag: geo.flag,
      status: 'active',
      ping: Math.floor(Math.random() * 35) + 15,
      jitter: Math.floor(Math.random() * 5),
      lossRatio: 0
    };
  }

  // Final fallback: if link contains :// anywhere, try extracting host
  if (uri.includes('://')) {
    const parts = uri.split('://');
    const scheme = parts[0].toUpperCase();
    const rest = parts[1].split('#');
    const name = rest[1] ? decodeURIComponent(rest[1]) : `${scheme} Node`;
    const hostPort = rest[0].split('@').pop().split('/')[0].split('?')[0];
    const [host, portStr] = hostPort.split(':');
    const geo = overrideCountry || resolveGeoIP((host || 'proxy.net') + ' ' + name);

    return {
      id,
      name,
      type: scheme,
      address: host || '127.0.0.1',
      port: parseInt(portStr) || 443,
      raw: uri,
      countryCode: geo.code,
      countryName: geo.country,
      flag: geo.flag,
      status: 'active',
      ping: Math.floor(Math.random() * 40) + 20,
      jitter: Math.floor(Math.random() * 5),
      lossRatio: 0
    };
  }

  return null;
}

function parseTextBlob(text, overrideCountry = null) {
  const results = [];
  if (!text) return results;

  let content = text.trim();
  if (!content.includes('://') && content.length > 20) {
    const decoded = safeBase64Decode(content);
    if (decoded.includes('://')) {
      content = decoded;
    }
  }

  const lines = content.split(/[\r\n]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      const node = parseSingleLink(trimmed, overrideCountry);
      if (node) {
        results.push(node);
      }
    }
  }
  return results;
}

module.exports = {
  parseSingleLink,
  parseTextBlob,
  resolveGeoIP,
  countryCodeToFlag,
  PRESET_COUNTRIES
};
