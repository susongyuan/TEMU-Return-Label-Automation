function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function queryText(value) {
  return compactText(value).toUpperCase();
}

function includesQuery(text, query) {
  if (!query) return false;
  return queryText(text).includes(queryText(query));
}

function redact(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

async function pageText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (compactText(text)) {
      parts.push(`[[frame:${frame.name() || 'main'} url:${frame.url()}]]\n${text}`);
    }
  }
  return parts.join('\n\n');
}

async function isVisibleHandle(handle) {
  return handle.evaluate(element => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }).catch(() => false);
}

async function findVisibleInFrames(page, selectors, timeout = 5000) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of selectorList) {
        try {
          const handle = await frame.$(selector);
          if (handle && await isVisibleHandle(handle)) {
            return { frame, handle, selector };
          }
        } catch {}
      }
    }
    await sleep(250);
  }
  return null;
}

async function firstVisible(page, selectors, timeout = 800) {
  const found = await findVisibleInFrames(page, selectors, timeout);
  return found?.handle || null;
}

async function setElementValue(handle, value) {
  await handle.evaluate((element, nextValue) => {
    const tagName = element.tagName;
    const prototype = tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, '');
    else element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (setter) setter.call(element, nextValue);
    else element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, value);
}

async function fillBySelector(page, selectors, value, timeout = 8000) {
  const found = await findVisibleInFrames(page, selectors, timeout);
  if (!found) return false;
  try {
    await setElementValue(found.handle, value);
    return true;
  } catch {
    return false;
  }
}

async function selectNativeByText(page, selectors, labels, timeout = 5000) {
  const found = await findVisibleInFrames(page, selectors, timeout);
  if (!found) return false;
  const labelList = (Array.isArray(labels) ? labels : [labels]).map(label => String(label));
  return found.handle.evaluate((select, wantedLabels) => {
    if (select.tagName !== 'SELECT') return false;
    const option = Array.from(select.options).find(item => {
      const text = (item.textContent || '').trim();
      return wantedLabels.some(label => text === label || text.includes(label) || item.value === label);
    });
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, labelList).catch(() => false);
}

async function clickByText(page, patterns, options = {}) {
  const regexes = patterns.map(pattern =>
    pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')
  );
  const source = regexes.map(regex => ({ source: regex.source, flags: regex.flags }));
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(sourcePatterns => {
      const localRegexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
      const nodes = Array.from(
        document.querySelectorAll('button, a, [role="button"], .ant-btn, .el-button, .winitd-btn, input[type="button"], input[type="submit"]')
      );
      const visible = nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const found = visible.find(node => {
        const text = (node.innerText || node.textContent || node.value || '').trim();
        return localRegexes.some(regex => regex.test(text));
      });
      if (!found) return false;
      found.click();
      return true;
    }, source).catch(() => false);
    if (clicked) {
      if (options.waitAfterMs) await sleep(options.waitAfterMs);
      return true;
    }
  }
  return false;
}

async function clickSelector(page, selectors, timeout = 5000, waitAfterMs = 0) {
  const found = await findVisibleInFrames(page, selectors, timeout);
  if (!found) return false;
  try {
    await found.handle.evaluate(element => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    });
    if (waitAfterMs) await sleep(waitAfterMs);
    return true;
  } catch {
    return false;
  }
}

async function fillFirstMatchingInput(page, value, hints = []) {
  const hintSources = hints.map(hint => hint instanceof RegExp ? hint.source : String(hint));
  const candidates = [];
  for (const frame of page.frames()) {
    const handles = await frame.$$('input, textarea').catch(() => []);
    for (const handle of handles) {
      const meta = await handle.evaluate((input, sourceHints) => {
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        const disabled = input.disabled || input.readOnly;
        if (disabled || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') {
          return null;
        }
        const hintRegexes = sourceHints.map(hint => new RegExp(hint, 'i'));
        const text = [
          input.placeholder,
          input.name,
          input.id,
          input.getAttribute('aria-label'),
          input.closest('label')?.innerText,
          input.parentElement?.innerText,
          input.closest('.ant-form-item, .el-form-item, .winitd-form-item')?.innerText
        ].filter(Boolean).join(' ');
        let score = 0;
        for (const regex of hintRegexes) {
          if (regex.test(text)) score += 10;
        }
        if (input.type === 'search') score += 3;
        if (input.type === 'text' || input.tagName === 'TEXTAREA') score += 2;
        return { score, text };
      }, hintSources).catch(() => null);
      if (meta) candidates.push({ handle, frame, score: meta.score, text: meta.text });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const target = candidates.find(candidate => hints.length === 0 || candidate.score > 0) || candidates[0];
  if (!target) return false;
  await target.handle.click({ clickCount: 3 }).catch(() => {});
  await target.handle.press('Control+A').catch(() => {});
  await target.handle.press('Backspace').catch(() => {});
  await setElementValue(target.handle, value);
  return true;
}

function extractTrackingNumbers(text) {
  const compact = String(text || '');
  const patterns = [
    /\b[A-Z]{1,4}\d{8,}[A-Z]{0,4}\b/g,
    /\b\d{10,30}\b/g,
    /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g
  ];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of compact.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

function extractMoneyCandidates(text) {
  const candidates = [];
  const pattern = /(?:RMB|CNY|USD|GBP|EUR|\$|£|€|￥)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:RMB|CNY|USD|GBP|EUR)?/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const amount = Number(match[1]);
    if (Number.isFinite(amount)) candidates.push(amount);
  }
  return candidates;
}

function contextAround(text, query, radius = 1200) {
  const source = String(text || '');
  const index = source.toUpperCase().indexOf(String(query || '').toUpperCase());
  if (index < 0) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + String(query).length + radius);
  return source.slice(start, end);
}

async function rowsContaining(page, queries) {
  const queryList = unique((Array.isArray(queries) ? queries : [queries]).map(String).filter(Boolean));
  const rows = [];
  if (!queryList.length) return rows;
  for (const frame of page.frames()) {
    const found = await frame.evaluate(sourceQueries => {
      const normalizedQueries = sourceQueries.map(query => query.replace(/\s+/g, ' ').trim().toUpperCase());
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
        '.winitd-table-row',
        '.ReactVirtualized__Table__row'
      ];
      const nodes = Array.from(document.querySelectorAll(rowSelectors.join(','))).filter(visible);
      return nodes
        .map(node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(text => text && normalizedQueries.some(query => text.toUpperCase().includes(query)));
    }, queryList).catch(() => []);
    for (const text of found) rows.push({ frameName: frame.name(), frameUrl: frame.url(), text });
  }
  return rows;
}

async function waitForQueryResult(page, query, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = await rowsContaining(page, query);
    if (rows.length) return rows;
    const text = await pageText(page);
    if (/无匹配数据|暂无数据|No Data|No matching/i.test(text)) return [];
    await sleep(500);
  }
  return rowsContaining(page, query);
}

module.exports = {
  clickByText,
  clickSelector,
  compactText,
  contextAround,
  extractMoneyCandidates,
  extractTrackingNumbers,
  fillBySelector,
  fillFirstMatchingInput,
  firstVisible,
  includesQuery,
  pageText,
  redact,
  rowsContaining,
  selectNativeByText,
  setElementValue,
  sleep,
  unique,
  waitForQueryResult,
  findVisibleInFrames,
};
