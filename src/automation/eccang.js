const { config } = require('../env');
const { normalizeOrderNo } = require('../order-normalizer');
const {
  clickByText,
  clickSelector,
  compactText,
  extractTrackingNumbers,
  fillBySelector,
  firstVisible,
  includesQuery,
  pageText,
  rowsContaining,
  selectNativeByText,
  sleep
} = require('./common');
const { gotoPlatform } = require('./browser');
const { loginIfNeeded } = require('./login');

function trackingCandidatesFrom(text, stOrderNo) {
  const source = String(text || '');
  const explicit = [];
  const labelPattern = /(?:订单跟踪号|跟踪号|快递单号|Track(?:ing)?\s*No\.?)[:：]?\s*([A-Z0-9]{8,40})/gi;
  for (const match of source.matchAll(labelPattern)) explicit.push(match[1]);
  if (!explicit.length) explicit.push(...extractTrackingNumbers(source));
  const stDigits = String(stOrderNo || '').replace(/\D/g, '');
  return [...new Set(explicit)].filter(candidate => {
    const digits = candidate.replace(/\D/g, '');
    return candidate !== stOrderNo &&
      digits !== stDigits &&
      !/^ST-?PO/i.test(candidate) &&
      !/^PO-\d/i.test(candidate) &&
      !/^(暂无|无|--|-|null|none)$/i.test(candidate) &&
      /[A-Z0-9]/i.test(candidate);
  });
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return compactText(match[1]);
  }
  return '';
}

function parseEccangProducts(text) {
  const source = compactText(text);
  const products = [];
  const skuPattern = /SKU[:：]\s*([A-Z0-9_-]+)[\s\S]{0,260}?(?:仓库SKU|海外仓SKU)[:：]\s*([A-Z0-9_-]+)(?:\[[^\]]+\])?[\s\S]{0,120}?Qty[:：]?\s*(\d+)/gi;
  for (const match of source.matchAll(skuPattern)) {
    products.push({
      sku: match[1],
      warehouseSku: match[2],
      quantity: Number(match[3]) || 1
    });
  }
  if (!products.length) {
    const sku = firstMatch(source, [/SKU[:：]\s*([A-Z0-9_-]+)/i]);
    const warehouseSku = firstMatch(source, [/(?:仓库SKU|海外仓SKU)[:：]\s*([A-Z0-9_-]+)/i]);
    const quantity = Number(firstMatch(source, [/Qty[:：]?\s*(\d+)/i])) || 1;
    if (sku || warehouseSku) {
      products.push({ sku: sku || warehouseSku, warehouseSku: warehouseSku || sku, quantity });
    }
  }
  const bySku = new Map();
  for (const item of products) {
    const key = item.warehouseSku || item.sku;
    const existing = bySku.get(key);
    if (!existing) {
      bySku.set(key, item);
      continue;
    }
    bySku.set(key, {
      sku: existing.sku || item.sku,
      warehouseSku: existing.warehouseSku || item.warehouseSku,
      quantity: Math.max(Number(existing.quantity) || 1, Number(item.quantity) || 1)
    });
  }
  return [...bySku.values()];
}

function countryCodeFromText(text) {
  const source = String(text || '');
  const countryText = firstMatch(source, [/国家或地区[:：]\s*([^\s\[]+)/i]);
  const bracket = firstMatch(source, [/(?:国家或地区|国家|Country)[:：][^\[]*\[([A-Z]{2})\]/i]);
  if (/^[A-Z]{2}$/i.test(bracket)) return bracket.toUpperCase();
  const normalized = `${countryText} ${bracket}`.toLowerCase();
  if (/英国|united kingdom|great britain|\buk\b/.test(normalized)) return 'GB';
  if (/澳大利亚|australia|\bau\b/.test(normalized)) return 'AU';
  if (/德国|germany|\bde\b/.test(normalized)) return 'DE';
  if (/美国|united states|\bus\b/.test(normalized)) return 'US';
  if (/加拿大|canada|\bca\b/.test(normalized)) return 'CA';
  if (/波兰|poland|\bpl\b/.test(normalized)) return 'PL';
  if (/法国|france|\bfr\b/.test(normalized)) return 'FR';
  if (/西班牙|spain|\bes\b/.test(normalized)) return 'ES';
  if (/意大利|italy|\bit\b/.test(normalized)) return 'IT';
  if (/荷兰|netherlands|\bnl\b/.test(normalized)) return 'NL';
  return '';
}

function parseEccangAddress(text) {
  const source = compactText(text);
  return {
    name: firstMatch(source, [/(?:收件人|收货人|姓名|Name)[:：]\s*([^\s]+)/i]),
    phone: firstMatch(source, [/(?:电话|手机|Phone|Tel)[:：]\s*([+0-9 ()-]{6,30})/i]),
    countryCode: countryCodeFromText(source),
    countryText: firstMatch(source, [/国家或地区[:：]\s*([^\s]+)/i, /(?:国家|Country)[:：]\s*([^\s]+)/i]),
    state: firstMatch(source, [/(?:省\/州|州|省|State|Province)[:：]\s*([^\s]+)/i]),
    city: firstMatch(source, [/(?:城市|City)[:：]\s*([^\s]+)/i]),
    postcode: firstMatch(source, [/(?:邮编|Postcode|Postal Code|Zip|Zipcode)[:：]?\s*([A-Z0-9 -]{3,12})/i]),
    address1: firstMatch(source, [/(?:地址1|地址一|详细地址|地址|Address1|Address 1|Address)[:：]\s*([^\n]+?)(?:\s+(?:地址2|国家|省\/州|州|城市|邮编|电话|手机|Email|邮箱)[:：]|$)/i]),
    address2: firstMatch(source, [/(?:地址2|地址二|Address2|Address 2)[:：]\s*([^\n]+?)(?:\s+(?:国家|省\/州|州|城市|邮编|电话|手机|Email|邮箱)[:：]|$)/i]),
    rawTextSnippet: source.slice(0, 1200)
  };
}

function parseEccangOrderText(text, stOrderNo, rows = []) {
  const body = String(text || '');
  const exactRows = rows.map(row => row.text || row).filter(row => includesQuery(row, stOrderNo));
  const uniqueResultBody = /当前共\s*1\s*条订单|Total\s*1\b|共\s*1\s*条/i.test(body) && includesQuery(body, stOrderNo);
  const targetText = exactRows.join('\n') || (uniqueResultBody ? body : '');
  const fallbackText = targetText ? `${targetText}\n${body}` : body;
  const trackingNumbers = trackingCandidatesFrom(fallbackText, stOrderNo);
  const warehouseMatches = [
    ...fallbackText.matchAll(/发运仓库[:：]?\s*([^\s\]\n]+)/g),
    ...fallbackText.matchAll(/发货仓库[:：]?\s*([^\s\]\n]+)/g),
    ...fallbackText.matchAll(/发运仓[:：]?\s*([^\s\]\n]+)/g),
    ...fallbackText.matchAll(/发货仓[:：]?\s*([^\s\]\n]+)/g),
    ...fallbackText.matchAll(/仓库配送[:：]?\s*([^\s\]\n]+)/g)
  ].map(match => match[1]);
  const warehouseText = warehouseMatches.find(Boolean) || '';
  const platform =
    /WINIT|万邑通/i.test(fallbackText) ? 'winit' :
    /GOODCANG|谷仓/i.test(fallbackText) ? 'goodcang' : '';
  const orderNoMatches = [
    ...fallbackText.matchAll(/订单[:：]?\s*([A-Z]{2,5}\d{6,}[-\d]*)/g),
    ...fallbackText.matchAll(/仓库单号[:：]?\s*([A-Z]{1,5}\d{6,}[-\d]*)/g),
    ...fallbackText.matchAll(/仓配单号[:：]?\s*([A-Z0-9_-]{6,})/g),
    ...fallbackText.matchAll(/\b(G\d{3,}-\d{6,}-\d{3,}|WO\d{6,}|SO\d{6,}|WEC\d{8,})\b/g)
  ].map(match => match[1]);
  const products = parseEccangProducts(fallbackText);
  const address = parseEccangAddress(fallbackText);

  return {
    stOrderNo,
    found: exactRows.length > 0 || includesQuery(body, stOrderNo),
    trackingNo: trackingNumbers[0] || '',
    trackingNumbers,
    warehouse: warehouseText,
    platform,
    warehouseOrderNo: orderNoMatches[0] || '',
    warehouseOrderCandidates: [...new Set(orderNoMatches)],
    products,
    primarySku: products[0]?.warehouseSku || products[0]?.sku || '',
    quantity: products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || products[0]?.quantity || 1,
    address,
    rawTextSnippet: compactText(fallbackText || body).slice(0, 4000)
  };
}

async function clickEccangAddressDetails(page, stOrderNo) {
  const patterns = [
    /查看地址|收货地址|地址详情|买家地址|客户地址/,
    /订单详情|详情/
  ];
  const patternSources = patterns.map(pattern => ({ source: pattern.source, flags: pattern.flags }));
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(({ orderNo, sourcePatterns }) => {
      const regexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const rowSelectors = [
        'tr',
        '[role="row"]',
        '.ant-table-row',
        '.el-table__row',
        '.vxe-body--row',
        '.ReactVirtualized__Table__row'
      ];
      const rows = Array.from(document.querySelectorAll(rowSelectors.join(',')))
        .filter(visible)
        .filter(row => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').includes(orderNo));
      const containers = rows.length ? rows : [document.body];
      for (const container of containers) {
        const nodes = Array.from(container.querySelectorAll('button, a, [role="button"], .ant-btn, .el-button, input[type="button"], span, div'))
          .filter(visible)
          .map(element => ({
            element,
            text: (element.innerText || element.textContent || element.value || '').replace(/\s+/g, '').trim()
          }))
          .filter(item => item.text && item.text.length <= 16);
        for (const regex of regexes) {
          const target = nodes.find(item => regex.test(item.text));
          if (target) {
            target.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
            target.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            target.element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            target.element.click();
            return true;
          }
        }
      }
      return false;
    }, { orderNo: stOrderNo, sourcePatterns: patternSources }).catch(() => false);
    if (clicked) {
      await sleep(1800);
      return true;
    }
  }
  return false;
}

async function ensureTemuOrderFrame(page) {
  const temuFrame = () => page.frames().find(frame => /order-list\/list\/platform\/semitemu/.test(frame.url()));
  const hasSearchControls = async () => {
    const frame = temuFrame();
    if (!frame) return false;
    return frame.evaluate(() => Boolean(document.querySelector('#code'))).catch(() => false);
  };
  const directTemuUrl = () => {
    const platformFrame = page.frames().find(frame => /order-platform-list\/list/.test(frame.url()));
    if (!platformFrame) return '';
    const source = new URL(platformFrame.url());
    const params = new URLSearchParams(source.search);
    params.set('display_old_page_expire_tip', '0');
    return `${source.origin}/order/order-list/list/platform/semitemu?${params.toString()}`;
  };

  if (await hasSearchControls()) return true;
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll('button, a, div, span, li, [role="button"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: (element.innerText || element.textContent || '').replace(/\s+/g, '').trim()
        }))
        .filter(item => item.text.includes('Temu半托管'))
        .sort((left, right) => left.text.length - right.text.length);
      const item = nodes.find(candidate => candidate.text === 'Temu半托管') || nodes[0];
      if (!item) return false;
      const node =
        item.element.closest('[data-platform="semitemu"], .orderPlatformListAllPlatformSemitemuBtnClazz') ||
        item.element;
      const before = node;
      before.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      before.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      before.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      before.click();
      return true;
    }).catch(() => false);
    if (clicked) break;
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await hasSearchControls()) return true;
    await sleep(500);
  }

  const url = directTemuUrl();
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const directDeadline = Date.now() + 30000;
    while (Date.now() < directDeadline) {
      if (await firstVisible(page, ['#code'], 1000)) return true;
      await sleep(500);
    }
  }
  return Boolean(await firstVisible(page, ['#code'], 1000));
}

async function clickRecentSixMonths(page) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll('button, a, div, span, li, [role="button"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: (element.innerText || element.textContent || '').replace(/\s+/g, '').trim()
        }))
        .filter(item => item.text === '近6个月订单' || item.text.includes('近6个月订单'))
        .sort((left, right) => left.text.length - right.text.length);
      const node = nodes[0]?.element;
      if (!node) return false;
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      node.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      await sleep(2500);
      return true;
    }
  }
  return false;
}

async function clearEccangSearchConditions(page) {
  const clicked = await clickByText(page, [/清空条件|重置|Reset/i], { waitAfterMs: 1200 });
  if (clicked) return true;
  for (const frame of page.frames()) {
    const cleared = await frame.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="reset"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: (element.innerText || element.textContent || element.value || '').replace(/\s+/g, '').trim()
        }))
        .filter(item => /清空条件|重置|Reset/i.test(item.text));
      const target = nodes[0]?.element;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }).catch(() => false);
    if (cleared) {
      await sleep(1200);
      return true;
    }
  }
  return false;
}

async function setEccangFieldValue(page, selector, value) {
  for (const frame of page.frames()) {
    const changed = await frame.evaluate(({ selector: targetSelector, value: nextValue }) => {
      const element = document.querySelector(targetSelector);
      if (!element) return false;
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { selector, value }).catch(() => false);
    if (changed) return true;
  }
  return false;
}

async function selectEccangOrderSearchType(page) {
  for (const frame of page.frames()) {
    const changed = await frame.evaluate(() => {
      const select = document.querySelector('#type');
      if (!select) return false;
      const options = Array.from(select.options || []);
      const preferred =
        options.find(option => /订单号/.test(option.textContent || '')) ||
        options.find(option => /order/i.test(`${option.value} ${option.textContent}`));
      if (!preferred) return false;
      select.value = preferred.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }).catch(() => false);
    if (changed) return true;
  }
  return false;
}

async function resetEccangStatusFilter(page) {
  for (const frame of page.frames()) {
    const changed = await frame.evaluate(() => {
      const select = document.querySelector('#status');
      if (!select) return false;
      const options = Array.from(select.options || []);
      const allOption =
        options.find(option => /全部|All/i.test(option.textContent || '')) ||
        options.find(option => option.value === '') ||
        options[0];
      if (!allOption) return false;
      select.value = allOption.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }).catch(() => false);
    if (changed) return true;
  }
  return false;
}

async function queryEccangOrder(rawOrderNo) {
  const stOrderNo = normalizeOrderNo(rawOrderNo);
  const page = await gotoPlatform('eccang', config.urls.eccang);
  await loginIfNeeded(page, 'eccang');
  if (!page.url().includes('/iframe')) {
    await page.goto(config.urls.eccang, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await sleep(3000);

  await ensureTemuOrderFrame(page);
  await clearEccangSearchConditions(page);
  await clickRecentSixMonths(page);
  let filled = false;
  for (let attempt = 0; attempt < 8 && !filled; attempt += 1) {
    await selectEccangOrderSearchType(page);
    await resetEccangStatusFilter(page);
    filled = await fillBySelector(page, ['#code', 'input[name="code"]'], stOrderNo, 5000);
    if (!filled) await sleep(1000);
  }
  if (!filled) {
    throw new Error('易仓 Temu 订单搜索框 #code 未找到');
  }
  const clicked =
    await clickByText(page, [/^\s*搜\s*索\s*$/, /搜索/], { waitAfterMs: 2500 }) ||
    await clickSelector(page, [
      'input.submitToSearch[value="搜索"]',
      'input[type="button"][value="搜索"]',
      'button[type="submit"]'
    ], 5000, 2500);
  if (!clicked) {
    await page.focus('#code').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
  await sleep(1500);

  const rows = await rowsContaining(page, stOrderNo);
  const beforeText = await pageText(page);
  const openedAddress = await clickEccangAddressDetails(page, stOrderNo);
  const text = openedAddress ? await pageText(page) : beforeText;
  return parseEccangOrderText(text, stOrderNo, rows);
}

async function probeEccang() {
  const page = await gotoPlatform('eccang', config.urls.eccang);
  const login = await loginIfNeeded(page, 'eccang');
  return {
    platform: 'eccang',
    login,
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: compactText(await pageText(page)).slice(0, 1000)
  };
}

module.exports = {
  parseEccangOrderText,
  probeEccang,
  queryEccangOrder
};
