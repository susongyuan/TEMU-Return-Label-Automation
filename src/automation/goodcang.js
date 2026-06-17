const { config } = require('../env');
const fs = require('fs');
const path = require('path');
const {
  clickByText,
  clickSelector,
  compactText,
  extractMoneyCandidates,
  extractTrackingNumbers,
  fillBySelector,
  firstVisible,
  includesQuery,
  pageText,
  rowsContaining,
  sleep
} = require('./common');
const { gotoPlatform } = require('./browser');
const { loginIfNeeded, looksLoggedIn } = require('./login');
const { calculateGoodcangShipping, matchCandidateByText } = require('./shipping-calculator');

const GOODCANG_RETURN_ADD_URL = 'https://oms.goodcang.com/order/return/add';
const GOODCANG_RETURN_LIST_URL = 'https://oms.goodcang.com/order/return?order_type=ReturnOrder';
const GOODCANG_RETURN_DETAILS_URL = 'https://oms.goodcang.com/order/return/details?code=';

function firstNonEmpty(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function mergeNonEmpty(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

async function ensureGoodcangLoggedIn(page) {
  try {
    await loginIfNeeded(page, 'goodcang');
  } catch (error) {
    if (!/login inputs not found/i.test(error.message) || !(await looksLoggedIn(page, 'goodcang'))) {
      throw error;
    }
  }
  if (/\/login(?:$|[/?#])/.test(page.url())) {
    throw new Error('谷仓当前会话未登录，请先在页面或“检查登录”中恢复登录状态');
  }
}

function parseGoodcangOrderText(text, query, rows = []) {
  const body = String(text || '');
  const exactRows = rows.map(row => row.text || row).filter(row => includesQuery(row, query));
  const targetText = exactRows.join('\n');
  const orderMatches = [
    ...targetText.matchAll(/\bG\d{3,}-\d{6,}-\d{3,}\b/g),
    ...targetText.matchAll(/\b[A-Z]{1,4}\d{3,}-\d{6,}-\d{3,}\b/g),
    ...targetText.matchAll(/\b(?:GC|GO|GD|G)\d{6,}[-A-Z0-9]*\b/g)
  ].map(match => match[0]);
  const warehouseMatches = [
    ...targetText.matchAll(/发货仓库?[:：]?\s*([A-Z0-9_-]{2,})/g),
    ...targetText.matchAll(/配送仓库?[:：]?\s*([A-Z0-9_-]{2,})/g),
    ...targetText.matchAll(/warehouse[_\s-]*code[:：]?\s*([A-Z0-9_-]{2,})/gi),
    ...targetText.matchAll(/\b([A-Z]{2,4}-\d+\[[^\]]+仓\])/g),
    ...targetText.matchAll(/\b([A-Z]{2,4}\[[^\]]+仓\])/g)
  ].map(match => match[1]);
  return {
    platform: 'goodcang',
    query,
    found: exactRows.length > 0,
    warehouseOrderNo: orderMatches[0] || '',
    warehouseOrderCandidates: [...new Set(orderMatches)],
    warehouse: warehouseMatches[0] || '',
    trackingNo: query,
    trackingNumbers: extractTrackingNumbers(targetText),
    matchedRows: exactRows.slice(0, 5),
    rawTextSnippet: compactText(targetText || body).slice(0, 4000)
  };
}

function parseLogisticsCandidates(text) {
  const lines = String(text || '').split(/\r?\n/).map(compactText).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    if (!/(物流|快递|shipping|courier|DHL|UPS|FedEx|Royal|USPS|Yodel|Evri)/i.test(line)) continue;
    const prices = extractMoneyCandidates(line).filter(value => value > 0);
    candidates.push({
      name: line.slice(0, 160),
      price: prices.length ? Math.min(...prices) : null
    });
  }
  return candidates.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
}

function parseGoodcangReturnDetails(text) {
  const source = compactText(text);
  const returnOrderNo =
    source.match(/\bRG\d{4}-\d{6}-\d{4}\b/i)?.[0] ||
    source.match(/\bASRO[-A-Z0-9]{4,}\b/i)?.[0] ||
    '';
  const status = source.match(/退货状态\s*([^\s]+)/)?.[1] || '';
  const trackingNo =
    source.match(/跟踪号\s*([A-Z0-9]{8,})/i)?.[1] ||
    extractTrackingNumbers(source).find(value => value !== returnOrderNo) ||
    '';
  const logisticsProduct = source.match(/物流产品\s*([A-Z0-9_-]{3,})/i)?.[1] || '';
  const feeMatches = [...source.matchAll(/(运输费|道路通行费|退件总费用)[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*([A-Z]{3})/g)];
  return {
    returnOrderNo,
    status,
    trackingNo,
    logisticsProduct,
    feeDetails: feeMatches.map(match => ({
      name: match[1],
      amount: Number(match[2]),
      currency: match[3]
    }))
  };
}

async function clickGoodcangText(page, textPattern, { rootSelector = '', waitAfterMs = 0 } = {}) {
  const source = textPattern instanceof RegExp
    ? { source: textPattern.source, flags: textPattern.flags || 'i' }
    : { source: String(textPattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'i' };
  const clicked = await page.evaluate(({ pattern, rootSelector: selector }) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const root = selector ? document.querySelector(selector) : document;
    if (!root) return null;
    const nodes = Array.from(root.querySelectorAll('button,a,label,li,span,[role="button"],[role="option"],.ant-btn,.ant-tabs-tab,.radio-block-item'))
      .filter(visible)
      .map(element => ({
        element,
        text: (element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(item => item.text && regex.test(item.text))
      .sort((left, right) => left.text.length - right.text.length);
    const match = nodes[0];
    if (!match) return null;
    fire(match.element);
    return match.text;
  }, { pattern: source, rootSelector }).catch(() => null);
  if (clicked && waitAfterMs) await sleep(waitAfterMs);
  return clicked;
}

async function clickGoodcangButton(page, selectorOrText, waitAfterMs = 1000) {
  const clicked = selectorOrText.startsWith?.('#') || selectorOrText.startsWith?.('.')
    ? await clickSelector(page, [selectorOrText], 5000, waitAfterMs)
    : await clickGoodcangText(page, new RegExp(`^${selectorOrText.replace(/\s+/g, '\\s*')}$`), { waitAfterMs });
  return Boolean(clicked);
}

async function selectGoodcangRadioText(page, rootSelector, label, waitAfterMs = 800) {
  const clicked = await clickGoodcangText(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
    rootSelector,
    waitAfterMs
  });
  return Boolean(clicked);
}

async function selectGoodcangDropdownOption(page, fieldSelector, preferredPatterns = [], waitAfterMs = 1000, { allowFallback = true } = {}) {
  const opened = await page.evaluate(selector => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const select = root.querySelector('.ant-select-selection,.ant-select,.ant-select-selector');
    if (!select || !visible(select)) return null;
    fire(select);
    return true;
  }, fieldSelector).catch(() => null);
  if (!opened) return null;
  await sleep(600);
  const patterns = preferredPatterns.map(pattern =>
    pattern instanceof RegExp
      ? { source: pattern.source, flags: pattern.flags || 'i' }
      : { source: String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'i' }
  );
  const selected = await page.evaluate(({ sourcePatterns, allowFallback: canFallback }) => {
    const regexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const options = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) li[role="option"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item'))
      .filter(visible)
      .map(element => ({
        element,
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(item => item.text);
    const match = regexes.length
      ? options.find(item => regexes.some(regex => regex.test(item.text)))
      : options[0];
    const selectedOption = match || (canFallback ? options[0] : null);
    if (!selectedOption) return null;
    fire(selectedOption.element);
    return {
      text: selectedOption.text,
      matched: Boolean(match),
      options: options.map(item => item.text).slice(0, 20)
    };
  }, { sourcePatterns: patterns, allowFallback }).catch(() => null);
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function setGoodcangFieldBySign(page, sign, value) {
  return page.evaluate(({ sign: fieldSign, value: nextValue }) => {
    const root = document.querySelector(`[data-sign="${fieldSign}"]`);
    const input = root?.querySelector('input,textarea');
    if (!input) return false;
    const prototype = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, nextValue);
    else input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return true;
  }, { sign, value }).catch(() => false);
}

async function splitGoodcangDoorplate(page) {
  return page.evaluate(() => {
    const getInput = sign => document.querySelector(`[data-sign="${sign}"] input`);
    const streetInput = getInput('street1');
    const doorInput = getInput('doorplate');
    if (!streetInput || !doorInput || doorInput.value.trim()) {
      return { changed: false };
    }
    const street = streetInput.value.trim();
    const match = street.match(/^(.+?)\s+([0-9][0-9A-Za-z/-]*)$/);
    if (!match) return { changed: false, street };
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    };
    setValue(streetInput, match[1]);
    setValue(doorInput, match[2]);
    return { changed: true, street: match[1], doorplate: match[2] };
  }).catch(() => ({ changed: false }));
}

async function readGoodcangReturnFormData(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const read = sign => document.querySelector(`[data-sign="${sign}"] input,[data-sign="${sign}"] textarea`)?.value || '';
    const signText = sign => (document.querySelector(`[data-sign="${sign}"]`)?.innerText || '').replace(/\s+/g, ' ').trim();
    const productRows = Array.from(document.querySelectorAll('[data-sign="gc_return_order_product_list"] tr, [data-sign="gc_return_order_product_list"] .ant-table-row'))
      .map(row => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const products = [];
    for (const rowText of productRows) {
      const sku = rowText.match(/\b\d{4,}-[A-Z0-9-]+\b/i)?.[0] || '';
      const qtyMatches = [...rowText.matchAll(/\b(\d+)\b/g)].map(match => Number(match[1])).filter(Number.isFinite);
      if (sku) products.push({ sku, warehouseSku: sku, quantity: qtyMatches.at(-1) || 1 });
    }
    if (!products.length) {
      const sku = text.match(/\b\d{4,}-[A-Z0-9-]+\b/i)?.[0] || '';
      if (sku) products.push({ sku, warehouseSku: sku, quantity: 1 });
    }
    const warehouseText = signText('warehouse_code') || text.match(/发货仓（区域仓）\s+([A-Z]{2}\[[^\]]+区\])/)?.[1] || '';
    const countryText = signText('country_code');
    return {
      warehouse: warehouseText,
      warehouseCode: read('warehouse_code'),
      products,
      address: {
        countryCode: countryText.match(/[A-Z]{2}/)?.[0] || '',
        state: read('state'),
        city: read('city'),
        postcode: read('post_code'),
        rawTextSnippet: text.slice(0, 1600)
      },
      rawTextSnippet: text.slice(0, 2500)
    };
  }).catch(() => ({ products: [], address: {}, warehouse: '' }));
}

async function chooseGoodcangLogistics(page, shippingQuote = null) {
  const quoted = shippingQuote?.selected;
  if (quoted?.code || quoted?.name) {
    const selected = await selectGoodcangDropdownOption(
      page,
      '[data-sign="sm_code"]',
      [quoted.code, quoted.name].filter(Boolean),
      1000,
      { allowFallback: false }
    );
    if (selected) {
      const selectedQuote = matchCandidateByText(shippingQuote.candidates || [], selected.text) || null;
      return {
        ...selected,
        quoted,
        selectedQuote,
        matchesQuotedSelection: Boolean(selectedQuote && (
          (quoted.code && selectedQuote.code === quoted.code) ||
          (quoted.name && selectedQuote.name === quoted.name) ||
          (quoted.code && includesQuery(selected.text, quoted.code)) ||
          (quoted.name && includesQuery(selected.text, quoted.name))
        ))
      };
    }
    return null;
  }
  const country = await page.evaluate(() => (document.querySelector('[data-sign="country_code"]')?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const warehouse = await page.evaluate(() => (document.querySelector('[data-sign="warehouse_code"]')?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const isGermanReturn = /DE\[|德国/.test(warehouse);
  const isFromGermany = /DE\[|德国/.test(country);
  const patterns = [];
  if (isGermanReturn && !isFromGermany) {
    patterns.push(/DHL.*国际|国际.*DHL|国际/);
  }
  if (isGermanReturn) {
    patterns.push(/DHL/, /DPD/, /GLS/);
  }
  patterns.push(/推荐|TUIJIANZIXUAN|DHL|UPS|DPD|GLS|Royal|USPS|物流|退件|Return/i);
  return selectGoodcangDropdownOption(page, '[data-sign="sm_code"]', patterns, 1000);
}

async function waitForGoodcangReturnOrder(page, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await pageText(page);
    const parsed = parseGoodcangReturnDetails(lastText);
    if (parsed.returnOrderNo || /新增成功|保存成功|成功/.test(lastText)) return { parsed, text: lastText };
    await sleep(600);
  }
  return { parsed: parseGoodcangReturnDetails(lastText), text: lastText };
}

async function submitGoodcangDrafts(page, returnOrderNos) {
  const orderNos = [...new Set((returnOrderNos || []).filter(Boolean))];
  await page.goto(GOODCANG_RETURN_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2500);
  await clickGoodcangText(page, /^草稿/, { waitAfterMs: 2500 });
  const selected = await page.evaluate(orderCodes => {
    const selectedRows = [];
    const missingRows = [];
    for (const orderNo of orderCodes) {
      const row = document.querySelector(`tr[data-row-key="${CSS.escape(orderNo)}"]`);
      const checkbox = row?.querySelector('input[type="checkbox"]');
      if (!row || !checkbox) {
        missingRows.push(orderNo);
        continue;
      }
      if (!checkbox.checked) checkbox.click();
      selectedRows.push(orderNo);
    }
    return { selectedRows, missingRows };
  }, orderNos).catch(() => ({ selectedRows: [], missingRows: orderNos }));
  if (selected.missingRows.length) {
    return {
      submitted: false,
      message: `谷仓草稿列表未找到退货单：${selected.missingRows.join(', ')}`
    };
  }
  await clickSelector(page, ['#order_return_batch_submit'], 5000, 1200);
  const confirmed = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const modal = Array.from(document.querySelectorAll('.ant-modal')).filter(visible).pop();
    const button = modal && Array.from(modal.querySelectorAll('button,.ant-btn'))
      .filter(visible)
      .find(item => (item.innerText || item.textContent || '').replace(/\s+/g, '') === '确定');
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (!confirmed) {
    return { submitted: false, message: '谷仓提交确认弹窗未找到确定按钮' };
  }
  await sleep(8000);
  const text = await pageText(page);
  if (/调用外部服务商异常|错误信息|失败/.test(text) && !/成功/.test(text)) {
    const message = compactText(text).match(/提交退货单\s+[A-Z0-9-]+\s+[^。]+/)?.[0] || '谷仓提交失败';
    return { submitted: false, message, rawTextSnippet: compactText(text).slice(0, 2000) };
  }
  return {
    submitted: /提交退货单[\s\S]{0,120}成功/.test(text),
    selectedRows: selected.selectedRows,
    rawTextSnippet: compactText(text).slice(0, 2000)
  };
}

async function selectGoodcangSubmittedRows(page, returnOrderNos) {
  const orderNos = [...new Set((returnOrderNos || []).filter(Boolean))];
  await page.goto(GOODCANG_RETURN_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2500);
  await clickGoodcangText(page, /^已提交/, { waitAfterMs: 2500 });
  return page.evaluate(orderCodes => {
    const selectedRows = [];
    const missingRows = [];
    for (const orderNo of orderCodes) {
      const row = document.querySelector(`tr[data-row-key="${CSS.escape(orderNo)}"]`);
      const checkbox = row?.querySelector('input[type="checkbox"]');
      if (!row || !checkbox) {
        missingRows.push(orderNo);
        continue;
      }
      if (!checkbox.checked) checkbox.click();
      selectedRows.push(orderNo);
    }
    return { selectedRows, missingRows };
  }, orderNos).catch(() => ({ selectedRows: [], missingRows: orderNos }));
}

async function configureDownloadPath(page, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir
  }).catch(async () => {
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir
    }).catch(() => {});
  });
}

function listDownloadFiles(downloadDir) {
  if (!fs.existsSync(downloadDir)) return [];
  return fs.readdirSync(downloadDir)
    .map(name => ({
      name,
      path: path.join(downloadDir, name),
      mtimeMs: fs.statSync(path.join(downloadDir, name)).mtimeMs
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function clickGoodcangBatchDownload(page) {
  const opened = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const controls = Array.from(document.querySelectorAll('button,.ant-btn,a,[role="button"]')).filter(visible);
    const button = controls.find(item => (item.innerText || item.textContent || '').replace(/\s+/g, '').includes('批量下载面单'));
    if (!button) return false;
    fire(button.querySelector('.anticon-down,svg') || button);
    return true;
  }).catch(() => false);
  if (!opened) return null;
  await sleep(800);
  const option = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const options = Array.from(document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) li,.ant-dropdown-menu-item,.ant-menu-item,[role="menuitem"]'))
      .filter(visible)
      .map(element => ({
        element,
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(item => item.text);
    const match = options.find(item => /面单|标签/.test(item.text)) || options[0];
    if (!match) return null;
    fire(match.element);
    return match.text;
  }).catch(() => null);
  if (option) await sleep(4000);
  return option;
}

async function clickGoodcangRowDownloads(page, returnOrderNos) {
  const clicked = await page.evaluate(orderCodes => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const clickedRows = [];
    const missingRows = [];
    for (const orderNo of orderCodes) {
      const row = document.querySelector(`tr[data-row-key="${CSS.escape(orderNo)}"]`);
      if (!row) {
        missingRows.push(orderNo);
        continue;
      }
      const controls = Array.from(row.querySelectorAll('button,a,.ant-btn,[role="button"]')).filter(visible);
      const download =
        controls.find(item => /下载/.test((item.innerText || item.textContent || '').replace(/\s+/g, ''))) ||
        controls.find(item => /面单|标签/.test((item.innerText || item.textContent || '').replace(/\s+/g, '')));
      if (!download) {
        missingRows.push(orderNo);
        continue;
      }
      fire(download);
      clickedRows.push(orderNo);
    }
    return { clickedRows, missingRows };
  }, returnOrderNos).catch(() => ({ clickedRows: [], missingRows: returnOrderNos }));
  if (clicked.clickedRows.length) await sleep(4000);
  return clicked;
}

async function downloadGoodcangLabels(page, returnOrderNos) {
  const downloadDir = path.join(config.moduleDir, '.runtime', 'downloads', 'goodcang');
  await configureDownloadPath(page, downloadDir);
  const before = listDownloadFiles(downloadDir);
  const selected = await selectGoodcangSubmittedRows(page, returnOrderNos);
  if (selected.missingRows.length) {
    return {
      downloaded: false,
      selectedRows: selected.selectedRows,
      missingRows: selected.missingRows,
      downloadDir,
      message: `已提交列表未找到退货单：${selected.missingRows.join(', ')}`
    };
  }

  const batchOption = await clickGoodcangBatchDownload(page);
  const fallback = batchOption ? null : await clickGoodcangRowDownloads(page, returnOrderNos);
  const after = listDownloadFiles(downloadDir);
  const beforeNames = new Set(before.map(file => `${file.name}:${file.mtimeMs}`));
  const newFiles = after.filter(file => !beforeNames.has(`${file.name}:${file.mtimeMs}`)).slice(0, 10);
  return {
    downloaded: Boolean(batchOption || fallback?.clickedRows?.length || newFiles.length),
    method: batchOption ? 'batch' : 'row',
    batchOption,
    fallback,
    selectedRows: selected.selectedRows,
    missingRows: selected.missingRows,
    downloadDir,
    files: newFiles
  };
}

async function findGoodcangOrder({ trackingNo }) {
  const query = trackingNo;
  if (!query) {
    return {
      platform: 'goodcang',
      found: false,
      message: '缺少易仓跟踪号，跳过谷仓查询'
    };
  }
  const page = await gotoPlatform('goodcang', config.urls.goodcang);
  if (!page.url().includes('/order/outbound_order')) {
    await page.goto(config.urls.goodcang, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await sleep(3000);
  await ensureGoodcangLoggedIn(page);
  await sleep(2500);
  await clickSelector(page, ['#outbound_order_list_ordinary_reset', '#outbound_order_list_draft_reset'], 1000, 500).catch(() => {});
  await clickSelector(page, ['#outbound_order_list_ordinary_code_type'], 3000, 300);
  await clickSelector(page, ['#outbound_order_list_ordinary_code_type_tracking_number'], 3000, 300);
  const filled = await fillBySelector(page, [
    '#outbound_order_list_ordinary_dblclick',
    '#outbound_order_list_draft_dblclick'
  ], query);
  if (!filled) {
    return {
      platform: 'goodcang',
      query,
      found: false,
      message: '谷仓跟踪号查询输入框未找到'
    };
  }
  const clicked = await clickSelector(page, [
    '#outbound_order_list_ordinary_search',
    '#outbound_order_list_draft_search'
  ], 5000, 2500);
  if (!clicked) await page.keyboard.press('Enter').catch(() => {});
  await sleep(1500);
  const rows = await rowsContaining(page, query);
  return parseGoodcangOrderText(await pageText(page), query, rows);
}

async function createGoodcangReturn({ order, dryRun = true, allowCreate = false, shippingQuote = null }) {
  const page = await gotoPlatform('goodcang', config.urls.goodcang);
  if (!page.url().includes('/order/outbound_order')) {
    await page.goto(config.urls.goodcang, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await sleep(3000);
  await ensureGoodcangLoggedIn(page);
  await page.goto(GOODCANG_RETURN_ADD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2000);
  await ensureGoodcangLoggedIn(page);
  const formReady = await firstVisible(page, ['#gc_return_order_add_order_code', '[data-sign="sm_code"]'], 10000);
  if (!formReady) {
    return {
      platform: 'goodcang',
      dryRun,
      created: false,
      needsReview: true,
      message: '谷仓退货新增页未出现可填写表单，请检查登录态或页面安全验证'
    };
  }

  const orderCode = order.warehouseOrderNo || '';
  if (!orderCode) {
    return {
      platform: 'goodcang',
      dryRun,
      created: false,
      message: '谷仓退货单需要仓库订单号，当前未匹配到'
    };
  }

  const orderFilled = await fillBySelector(page, ['#gc_return_order_add_order_code'], orderCode, 10000);
  if (!orderFilled) {
    return {
      platform: 'goodcang',
      dryRun,
      created: false,
      needsReview: true,
      message: '谷仓退货新增页未找到仓库订单号输入框'
    };
  }
  await clickGoodcangText(page, /^添\s*加$/, { waitAfterMs: 2500 });
  await sleep(2500);

  const stepStatus = {};
  stepStatus.formData = await readGoodcangReturnFormData(page);
  const quoteInput = {
    ...order,
    warehouse: firstNonEmpty(stepStatus.formData.warehouse, order.warehouse),
    warehouseCode: firstNonEmpty(stepStatus.formData.warehouseCode, order.warehouseCode),
    rawTextSnippet: firstNonEmpty(stepStatus.formData.rawTextSnippet, order.rawTextSnippet),
    products: stepStatus.formData.products?.length ? stepStatus.formData.products : order.products,
    address: mergeNonEmpty(order.address || {}, stepStatus.formData.address || {})
  };
  const quote = shippingQuote?.candidates?.length
    ? shippingQuote
    : await calculateGoodcangShipping(quoteInput, page).catch(error => ({
      platform: 'goodcang',
      quoted: false,
      candidates: [],
      selected: null,
      message: error.message
    }));
  stepStatus.shippingQuoteMessage = quote.message;
  stepStatus.deliveryMode = await selectGoodcangRadioText(page, '[data-sign="sm_type"]', '代选物流', 1500);
  stepStatus.logistics = await chooseGoodcangLogistics(page, quote);
  stepStatus.serviceType = await selectGoodcangRadioText(page, '[data-sign="service_type"]', '退件质检', 800);
  await setGoodcangFieldBySign(page, 'asro_reason', order.returnReason || 'customer return');
  stepStatus.addressSplit = await splitGoodcangDoorplate(page);

  const text = await pageText(page);
  const candidates = parseLogisticsCandidates(text);
  const selected = stepStatus.logistics?.selectedQuote ||
    quote?.selected ||
    (stepStatus.logistics ? { name: stepStatus.logistics.text, price: null } : null) ||
    candidates.find(candidate => Number.isFinite(candidate.price)) ||
    null;

  const result = {
    platform: 'goodcang',
    dryRun,
    draftOnly: true,
    stepStatus,
    shippingQuote: quote,
    selectedLogistics: selected,
    logisticsCandidates: (quote?.candidates?.length ? quote.candidates : candidates).slice(0, 8),
    rawTextSnippet: compactText(text).slice(0, 3000)
  };

  const selectedQuoteMatches = !quote?.selected || Boolean(stepStatus.logistics?.matchesQuotedSelection);

  if (!allowCreate || dryRun) {
    result.created = false;
    result.message = 'Dry-run: filled Goodcang draft form and skipped Save/Submit.';
    return result;
  }

  if (!quote?.selected || !stepStatus.logistics || !selectedQuoteMatches || /暂无数据|请选择/.test(stepStatus.logistics.text || '')) {
    result.created = false;
    result.needsReview = true;
    result.message = '谷仓真实创建已停止：费用计算器未返回可用最低价物流，或创建页未能精确选中最低价物流产品。';
    return result;
  }

  await clickGoodcangButton(page, '#gc_return_order_add_save', 4000);
  const { parsed, text: afterText } = await waitForGoodcangReturnOrder(page, 12000);
  const returnOrder =
    parsed.returnOrderNo ||
    afterText.match(/\bRG\d{4}-\d{6}-\d{4}\b/i)?.[0] ||
    afterText.match(/\bASRO[-A-Z0-9]{4,}\b/i)?.[0] ||
    '';
  result.created = Boolean(returnOrder);
  result.returnOrderNo = returnOrder;
  result.status = parsed.status || '草稿';
  result.trackingNo = parsed.trackingNo || '';
  result.message = returnOrder
    ? '谷仓草稿已创建，等待本批次全部草稿创建完后统一提交/下载面单。'
    : '谷仓草稿创建后未解析到退货单号';
  result.rawTextSnippet = compactText(afterText).slice(0, 4000);
  return result;
}

async function finalizeGoodcangReturns({ returnOrderNos, dryRun = true, allowCreate = false } = {}) {
  const orderNos = [...new Set((returnOrderNos || []).filter(Boolean))];
  if (!orderNos.length) {
    return {
      platform: 'goodcang',
      submitted: false,
      downloaded: false,
      message: '没有需要批量提交的谷仓草稿'
    };
  }

  const page = await gotoPlatform('goodcang', config.urls.goodcang);
  await ensureGoodcangLoggedIn(page);

  if (!allowCreate || dryRun) {
    return {
      platform: 'goodcang',
      dryRun,
      submitted: false,
      downloaded: false,
      returnOrderNos: orderNos,
      message: 'Dry-run: Goodcang drafts are not submitted or downloaded.'
    };
  }

  const submit = await submitGoodcangDrafts(page, orderNos);
  if (!submit.submitted) {
    return {
      platform: 'goodcang',
      dryRun,
      submitted: false,
      downloaded: false,
      returnOrderNos: orderNos,
      message: submit.message || '谷仓批量提交未成功',
      rawTextSnippet: submit.rawTextSnippet
    };
  }

  const details = [];
  for (const returnOrderNo of orderNos) {
    await page.goto(`${GOODCANG_RETURN_DETAILS_URL}${encodeURIComponent(returnOrderNo)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });
    await sleep(2500);
    const text = await pageText(page);
    details.push({
      returnOrderNo,
      ...parseGoodcangReturnDetails(text),
      rawTextSnippet: compactText(text).slice(0, 2000)
    });
  }

  const download = await downloadGoodcangLabels(page, orderNos);
  return {
    platform: 'goodcang',
    dryRun,
    submitted: true,
    downloaded: download.downloaded,
    returnOrderNos: orderNos,
    details,
    download,
    message: download.downloaded
      ? '谷仓草稿已批量提交，并已触发批量下载面单/二维码。'
      : '谷仓草稿已批量提交，但批量下载面单/二维码需要复核。'
  };
}

async function probeGoodcang() {
  const page = await gotoPlatform('goodcang', config.urls.goodcang);
  const login = await loginIfNeeded(page, 'goodcang');
  return {
    platform: 'goodcang',
    login,
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: compactText(await pageText(page)).slice(0, 1000)
  };
}

module.exports = {
  createGoodcangReturn,
  finalizeGoodcangReturns,
  findGoodcangOrder,
  parseGoodcangOrderText,
  parseLogisticsCandidates,
  parseGoodcangReturnDetails,
  probeGoodcang
};
