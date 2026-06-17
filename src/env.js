const fs = require('fs');
const path = require('path');

const MODULE_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(MODULE_DIR, '.env');

function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveModulePath(value, fallback) {
  const raw = value || fallback;
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(MODULE_DIR, raw);
}

loadEnv();

const config = {
  moduleDir: MODULE_DIR,
  host: process.env.RETURN_AUTOMATION_HOST || '127.0.0.1',
  port: intEnv('RETURN_AUTOMATION_PORT', 3206),
  cdpPort: intEnv('RETURN_AUTOMATION_CDP_PORT', 9333),
  edgePath:
    process.env.BROWSER_EDGE_PATH ||
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: resolveModulePath(process.env.BROWSER_USER_DATA_DIR, '.runtime/edge-user-data'),
  headless: boolEnv('BROWSER_HEADLESS', true),
  bringToFront: boolEnv('BROWSER_BRING_TO_FRONT', false),
  apiMode: process.env.API_MODE || 'api',
  dryRunDefault: boolEnv('DRY_RUN_DEFAULT', true),
  preferCrawlerOnly: boolEnv('PREFER_CRAWLER_ONLY', false),
  realCreateMaxPerJob: intEnv('REAL_CREATE_MAX_PER_JOB', 5),
  orderConcurrency: intEnv('ORDER_CONCURRENCY', 5),
  api: {
    goodcang: {
      baseUrl: process.env.GOODCANG_API_BASE || 'https://oms.goodcang.net/public_open',
      appToken: process.env.GOODCANG_APP_TOKEN || '',
      appKey: process.env.GOODCANG_APP_KEY || ''
    },
    winit: {
      baseUrl: process.env.WINIT_API_BASE || 'https://openapi.winit.com.cn/openapi/service',
      token: process.env.WINIT_TOKEN || '',
      appKey: process.env.WINIT_APP_KEY || '',
      platform: process.env.WINIT_PLATFORM || 'OWNERERP',
      clientId: process.env.WINIT_CLIENT_ID || '',
      clientSecret: process.env.WINIT_CLIENT_SECRET || ''
    },
    eccang: {
      baseUrl: process.env.ECCANG_API_BASE || 'http://openapi-web.eccang.com/openApi/api/unity',
      appKey: process.env.ECCANG_APP_KEY || '',
      appSecret: process.env.ECCANG_APP_SECRET || '',
      serviceId: process.env.ECCANG_SERVICE_ID || '',
      charset: process.env.ECCANG_CHARSET || 'UTF-8',
      signUppercase: boolEnv('ECCANG_SIGN_UPPERCASE', true)
    }
  },
  credentials: {
    winit: {
      username: process.env.WINIT_USERNAME || '',
      password: process.env.WINIT_PASSWORD || ''
    },
    goodcang: {
      username: process.env.GOODCANG_USERNAME || '',
      password: process.env.GOODCANG_PASSWORD || ''
    },
    eccang: {
      username: process.env.ECCANG_USERNAME || '',
      password: process.env.ECCANG_PASSWORD || ''
    }
  },
  urls: {
    eccang: process.env.ECCANG_URL || 'https://home.eccang.com/entry/EBR9GC/ERP/iframe#/m_71579',
    goodcang:
      process.env.GOODCANG_URL || 'https://oms.goodcang.com/order/outbound_order',
    winit: process.env.WINIT_URL || 'https://seller.winit.com.cn/WHOutbound/index'
  }
};

module.exports = {
  config,
  loadEnv
};
