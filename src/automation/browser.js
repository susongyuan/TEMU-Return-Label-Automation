const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { config } = require('../env');
const { sleep } = require('./common');

let browserPromise = null;
let edgeProcess = null;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${url} -> ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => {
      req.destroy(new Error('CDP probe timeout'));
    });
  });
}

async function isCdpReady() {
  try {
    await getJson(`http://127.0.0.1:${config.cdpPort}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function ensureEdgeCdp() {
  if (await isCdpReady()) return;
  if (!fs.existsSync(config.edgePath)) {
    throw new Error(`Edge not found: ${config.edgePath}`);
  }
  fs.mkdirSync(config.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--disable-features=msEdgeSidebarV2'
  ];
  if (config.headless) {
    args.push('--headless=new', '--disable-gpu', '--window-size=1440,1000');
  }
  args.push('about:blank');
  edgeProcess = spawn(config.edgePath, args, {
    cwd: config.moduleDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  edgeProcess.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isCdpReady()) return;
    await sleep(500);
  }
  throw new Error(`Edge CDP did not start on port ${config.cdpPort}`);
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      await ensureEdgeCdp();
      return puppeteer.connect({
        browserURL: `http://127.0.0.1:${config.cdpPort}`,
        defaultViewport: null,
        protocolTimeout: 180000
      });
    })();
  }
  return browserPromise;
}

async function getOrCreatePage(platformKey, url) {
  const browser = await getBrowser();
  const pages = await browser.pages().catch(() => []);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const existing = pages.find(page => {
    try {
      return new URL(page.url()).hostname.replace(/^www\./, '').endsWith(host);
    } catch {
      return false;
    }
  });
  const page = existing || await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);
  page.__platformKey = platformKey;
  return page;
}

async function gotoPlatform(platformKey, url) {
  const page = await getOrCreatePage(platformKey, url);
  if (config.bringToFront) {
    await page.bringToFront().catch(() => {});
  }
  if (!page.url().startsWith(url.split('#')[0]) && page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } else if (page.url() === 'about:blank') {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  return page;
}

async function closeBrowserConnection() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.disconnect().catch(() => {});
}

module.exports = {
  closeBrowserConnection,
  ensureEdgeCdp,
  getBrowser,
  getOrCreatePage,
  gotoPlatform
};
