const { config } = require('../env');
const {
  clickByText,
  clickSelector,
  compactText,
  extractMoneyCandidates,
  extractTrackingNumbers,
  fillFirstMatchingInput,
  fillBySelector,
  includesQuery,
  pageText,
  rowsContaining,
  sleep
} = require('./common');
const { getBrowser, getOrCreatePage, gotoPlatform } = require('./browser');
const { loginIfNeeded } = require('./login');
const { calculateWinitShipping, matchCandidateByText } = require('./shipping-calculator');

const WINIT_RETURN_URL = 'https://seller.winit.com.cn/ReturnOrders/stepOneNewWH';
const DEFAULT_RETURN_QUANTITY = 2;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexSources(patterns) {
  return (Array.isArray(patterns) ? patterns : [patterns])
    .filter(Boolean)
    .map(pattern => {
      if (pattern instanceof RegExp) {
        return { source: pattern.source, flags: pattern.flags || 'i' };
      }
      return { source: escapeRegExp(compactText(pattern)), flags: 'i' };
    });
}

function withTimeout(promise, ms, fallback = null) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function evaluateInWinitFrames(page, pageFunction, arg) {
  for (const frame of page.frames()) {
    const result = await withTimeout(frame.evaluate(pageFunction, arg).catch(() => null), 5000, null);
    if (result) return result;
  }
  return null;
}

function extractWinitTrackingNumbers(text) {
  const source = String(text || '');
  const found = new Set(extractTrackingNumbers(source));
  const patterns = [
    /\b\d{2,4}[A-Z]{1,4}\d{8,}[A-Z]{0,4}\b/g,
    /\b[A-Z]{1,4}\d{8,}[A-Z]{0,4}\b/g,
    /\b\d{10,30}\b/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

function parseWinitOrderText(text, query, rows = []) {
  const body = String(text || '');
  const exactRows = rows.map(row => row.text || row).filter(row => includesQuery(row, query));
  const targetText = exactRows.join('\n');
  const orderMatches = [
    ...targetText.matchAll(/\bWO\d{6,}\b/g),
    ...targetText.matchAll(/\bSO\d{6,}\b/g),
    ...targetText.matchAll(/\bRT\d{6,}[A-Z]{0,4}\b/g)
  ].map(match => match[0]);
  const warehouseMatches = [
    ...targetText.matchAll(/下单仓库\s+([A-Z0-9 _-]+?Warehouse)/gi),
    ...targetText.matchAll(/出货仓库\s+([A-Z0-9 _-]+?Warehouse)/gi),
    ...targetText.matchAll(/\b([A-Z]{2,}[A-Z0-9]*\s+Warehouse)\b/g),
    ...targetText.matchAll(/仓库(?:编码|代码)?[:：]?\s*([A-Z0-9_-]{2,})/g),
    ...targetText.matchAll(/收货仓[:：]?\s*([A-Z0-9_-]{2,})/g),
  ].map(match => match[1]);
  return {
    platform: 'winit',
    query,
    found: exactRows.length > 0,
    warehouseOrderNo: orderMatches[0] || '',
    warehouseOrderCandidates: [...new Set(orderMatches)],
    warehouse: warehouseMatches[0] || '',
    trackingNo: query,
    trackingNumbers: extractWinitTrackingNumbers(targetText).filter(value => !/^(WO|SO|RT)\d/i.test(value)),
    matchedRows: exactRows.slice(0, 5),
    rawTextSnippet: compactText(targetText || body).slice(0, 4000)
  };
}

function parseWinitOrderRecord(record, query) {
  if (!record || typeof record !== 'object') return null;
  const trackingNumbers = [
    ...(Array.isArray(record.trackingNoList)
      ? record.trackingNoList.map(item => item?.trackingNo).filter(Boolean)
      : []),
    record.trackingNo,
    record.winitTrackingNo
  ].filter(Boolean);
  const matchedTracking = trackingNumbers.some(value => includesQuery(value, query));
  if (!matchedTracking && !includesQuery(record.orderNo, query) && !includesQuery(record.sellerOrderNo, query)) {
    return null;
  }
  const warehouse =
    record.warehouseName ||
    record.orderWarehouseName ||
    record.actualWarehouseInfoList?.[0] ||
    record.orderWarehouseCode ||
    record.warehouseCode ||
    '';
  const warehouseCode =
    record.warehouseCode ||
    record.orderWarehouseCode ||
    record.shipWarehouseCode ||
    record.actualWarehouseCode ||
    '';
  const sellerOrderNo =
    record.sellerOrderNo ||
    record.customerOrderNo ||
    record.referenceNo ||
    record.refNo ||
    '';
  const matchedRow = compactText([
    record.orderNo,
    sellerOrderNo,
    trackingNumbers.join(' '),
    warehouse,
    warehouseCode,
    record.orderWinitProductName,
    record.estimateTotalAmount && `${record.estimateTotalAmount} ${record.estimateTotalAmountCurrencyCode || ''}`
  ].filter(Boolean).join(' '));
  return {
    platform: 'winit',
    query,
    found: true,
    source: 'winit-page-request',
    warehouseOrderNo: record.orderNo || '',
    warehouseOrderCandidates: [record.orderNo].filter(Boolean),
    warehouse,
    warehouseCode,
    sellerOrderNo,
    customerOrderNo: sellerOrderNo,
    storeType: record.storeType || record.orderStoreType || record.platform || '',
    productCode: record.productCode || record.orderWinitProductCode || '',
    trackingNo: query,
    trackingNumbers,
    matchedRows: matchedRow ? [matchedRow] : [],
    rawTextSnippet: matchedRow.slice(0, 4000)
  };
}

function extractWinitPrice(text) {
  const source = String(text || '');
  const explicitPatterns = [
    /(?:总费用|费用|价格|Fee|Price)[^0-9$￥£€]{0,20}(?:AUD|USD|CNY|RMB)?\s*[$￥£€]?\s*([0-9]+(?:\.[0-9]+)?)/gi,
    /(?:AUD|USD|CNY|RMB|\$|￥|£|€)\s*([0-9]+(?:\.[0-9]+)?)/gi,
    /([0-9]+(?:\.[0-9]+)?)\s*(?:AUD|USD|CNY|RMB)/gi
  ];
  for (const pattern of explicitPatterns) {
    const values = [...source.matchAll(pattern)]
      .map(match => Number(match[1]))
      .filter(Number.isFinite);
    if (values.length) return values[0];
  }
  const candidates = extractMoneyCandidates(source).filter(value => value > 0);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function parseWinitLogisticsCandidates(text) {
  if (!/(总费用|费用明细|配送时效|处理时效|物流产品|AU\s*Post|eParcel|Return Service)/i.test(String(text || ''))) return [];
  const lines = String(text || '').split(/\r?\n/).map(compactText).filter(Boolean);
  const candidates = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const context = compactText([lines[index - 1], line, lines[index + 1], lines[index + 2]].filter(Boolean).join(' '));
    if (context.length > 700) continue;
    if (!/(Return|DHL|UPS|USPS|Royal|DPD|退货|派送|快递|物流|PSC|AU\s*Post|eParcel|Parcel\s*Post)/i.test(context)) continue;
    const nameMatch = context.match(/AU\s*Post[\s\S]{0,220}?eParcel\s+Return\s+Service[\s\S]{0,80}?(?:\)-AU|-AU|\bAU\b)/i);
    const name = compactText(nameMatch?.[0] || line).slice(0, 220);
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      name,
      price: extractWinitPrice(context)
    });
  }
  return candidates.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
}

async function clickWinitText(page, patterns, options = {}) {
  const clicked = await evaluateInWinitFrames(page, sourcePatterns => {
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
    const textOf = element => (element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      'button',
      'a',
      'label',
      'li',
      '[role="button"]',
      '[role="option"]',
      '.ant-btn',
      '.winitd-btn',
      '.ant-select-item-option',
      '.winitd-select-item-option',
      '.ant-dropdown-menu-item',
      '.winitd-dropdown-menu-item',
      '.ant-radio-wrapper',
      '.winitd-radio-wrapper',
      '.ant-checkbox-wrapper',
      '.winitd-checkbox-wrapper'
    ];
    const matches = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(visible)
      .map(element => ({ element, text: textOf(element) }))
      .filter(item => item.text && regexes.some(regex => regex.test(item.text)))
      .sort((left, right) => left.text.length - right.text.length);
    const match = matches[0];
    if (!match) return null;
    const input = match.element.querySelector?.('input:not([disabled])');
    fire(input || match.element);
    return { text: match.text.slice(0, 180) };
  }, regexSources(patterns));
  if (clicked && options.waitAfterMs) await sleep(options.waitAfterMs);
  return clicked;
}

async function setWinitChoice(page, labels, options = {}) {
  const selected = await evaluateInWinitFrames(page, ({ sourcePatterns, kind, checked }) => {
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
    const textOf = element => (element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim();
    const matches = text => regexes.some(regex => regex.test(text));
    const wrapperSelector = kind === 'checkbox'
      ? '.ant-checkbox-wrapper,.winitd-checkbox-wrapper,label'
      : kind === 'radio'
        ? '.ant-radio-wrapper,.winitd-radio-wrapper,label'
        : '.ant-radio-wrapper,.winitd-radio-wrapper,.ant-checkbox-wrapper,.winitd-checkbox-wrapper,label';
    const wrappers = Array.from(document.querySelectorAll(wrapperSelector))
      .filter(visible)
      .map(element => ({ element, text: textOf(element) }))
      .filter(item => item.text && matches(item.text))
      .sort((left, right) => left.text.length - right.text.length);
    const wrapper = wrappers[0];
    if (wrapper) {
      const input = wrapper.element.querySelector('input');
      if (input && input.checked === checked) return { text: wrapper.text, already: true };
      fire(input || wrapper.element);
      return { text: wrapper.text };
    }
    const inputTypes = kind === 'checkbox' ? ['checkbox'] : kind === 'radio' ? ['radio'] : ['checkbox', 'radio'];
    const inputs = Array.from(document.querySelectorAll(inputTypes.map(type => `input[type="${type}"]`).join(',')));
    const matchedInput = inputs.find(input => {
      const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
      const context = [
        input.value,
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        label?.innerText,
        input.closest('label')?.innerText,
        input.closest('.ant-form-item,.winitd-form-item')?.innerText,
        input.parentElement?.innerText
      ].filter(Boolean).join(' ');
      return matches(context.replace(/\s+/g, ' ').trim());
    });
    if (!matchedInput) return null;
    if (matchedInput.checked === checked) return { text: matchedInput.value || matchedInput.id || '', already: true };
    fire(matchedInput);
    return { text: matchedInput.value || matchedInput.id || '' };
  }, {
    sourcePatterns: regexSources(labels),
    kind: options.kind || '',
    checked: options.checked !== false
  });
  if (selected && options.waitAfterMs) await sleep(options.waitAfterMs);
  return selected;
}

async function setWinitControlValue(page, { type, value, checked = true, waitAfterMs = 0 }) {
  const selected = await evaluateInWinitFrames(page, ({ inputType, inputValue, shouldBeChecked }) => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const input = Array.from(document.querySelectorAll(`input[type="${inputType}"]`))
      .find(item => item.value === inputValue && !item.disabled && visible(item));
    if (!input) return null;
    if (input.checked === shouldBeChecked) {
      return { value: input.value, already: true };
    }
    const target = input.closest('label,.winitd-radio-wrapper,.winitd-checkbox-wrapper,.ant-radio-wrapper,.ant-checkbox-wrapper') || input;
    fire(target);
    return { value: input.value, checked: input.checked };
  }, { inputType: type, inputValue: value, shouldBeChecked: checked });
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function setWinitMainControlValue(page, { type, value, checked = true, waitAfterMs = 0 }) {
  const selected = await page.evaluate(async ({ inputType, inputValue, shouldBeChecked }) => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fire = element => {
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const input = Array.from(document.querySelectorAll(`input[type="${inputType}"]`))
      .find(item => item.value === inputValue && !item.disabled && visible(item));
    if (!input) return null;
    if (input.checked !== shouldBeChecked) {
      const target = input.closest('label,.winitd-radio-wrapper,.winitd-checkbox-wrapper,.ant-radio-wrapper,.ant-checkbox-wrapper') || input;
      fire(target);
      await delay(1000);
    }
    return {
      value: input.value,
      checked: input.checked,
      hasOutboundOrderNo: Boolean(document.querySelector('#outboundOrderNo'))
    };
  }, { inputType: type, inputValue: value, shouldBeChecked: checked }).catch(() => null);
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function clickWinitInputByValue(page, type, value, waitAfterMs = 1000) {
  const target = await page.evaluate(({ inputType, inputValue }) => {
    const input = Array.from(document.querySelectorAll(`input[type="${inputType}"]`))
      .find(item => item.value === inputValue && !item.disabled);
    if (!input) return null;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }, { inputType: type, inputValue: value }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y);
  if (waitAfterMs) await sleep(waitAfterMs);
  return page.evaluate(({ inputType, inputValue }) => {
    const input = Array.from(document.querySelectorAll(`input[type="${inputType}"]`))
      .find(item => item.value === inputValue);
    return input ? { value: input.value, checked: input.checked } : null;
  }, { inputType: type, inputValue: value }).catch(() => null);
}

async function dismissWinitOverlays(page) {
  return page.evaluate(() => {
    const selectors = [
      '#aiChatbotRoot',
      '.ai-chatbot',
      '.udesk-client',
      '#udesk_container'
    ];
    let changed = 0;
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        element.style.pointerEvents = 'none';
        element.style.display = 'none';
        changed += 1;
      }
    }
    document.body?.classList?.remove('aiChatbot_open');
    return changed;
  }).catch(() => 0);
}

async function setWinitCheckboxById(page, id, checked = true, waitAfterMs = 500) {
  const selected = await page.evaluate(({ checkboxId, shouldBeChecked }) => {
    const checkbox = document.querySelector(`#${CSS.escape(checkboxId)}`);
    if (!checkbox) return null;
    if (checkbox.checked !== shouldBeChecked && !checkbox.disabled) {
      checkbox.click();
    }
    return {
      id: checkbox.id,
      checked: checkbox.checked,
      disabled: checkbox.disabled
    };
  }, { checkboxId: id, shouldBeChecked: checked }).catch(() => null);
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function waitForWinitSelector(page, selector, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate(targetSelector => {
      const element = document.querySelector(targetSelector);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }, selector).catch(() => false);
    if (found) return true;
    await sleep(300);
  }
  return false;
}

async function selectWinitDropdown(page, fieldLabels, optionLabels, waitAfterMs = 800) {
  const opened = await evaluateInWinitFrames(page, ({ fieldPatterns, optionPatterns }) => {
    const fieldRegexes = fieldPatterns.map(item => new RegExp(item.source, item.flags));
    const optionRegexes = optionPatterns.map(item => new RegExp(item.source, item.flags));
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
    const matches = (text, regexes) => regexes.some(regex => regex.test((text || '').replace(/\s+/g, ' ').trim()));
    const selectByNativeOption = select => {
      const option = Array.from(select.options).find(item => {
        const text = [item.textContent, item.value, item.title].filter(Boolean).join(' ');
        return matches(text, optionRegexes);
      });
      if (!option) return null;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { selectedNative: true, text: option.textContent || option.value };
    };
    const containers = Array.from(document.querySelectorAll('.ant-form-item,.winitd-form-item,.form-group,tr,[role="row"],li,section,div'))
      .filter(visible)
      .map(element => ({ element, text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter(item => item.text && matches(item.text, fieldRegexes))
      .sort((left, right) => left.text.length - right.text.length);
    for (const item of containers) {
      const nativeSelect = Array.from(item.element.querySelectorAll('select')).find(visible);
      if (nativeSelect) {
        const selected = selectByNativeOption(nativeSelect);
        if (selected) return selected;
      }
      const selector = item.element.querySelector('.ant-select:not(.ant-select-disabled),.winitd-select:not(.winitd-select-disabled),.ant-cascader-picker,.winitd-cascader-picker');
      if (!selector || !visible(selector)) continue;
      fire(selector.querySelector('.ant-select-selector,.winitd-select-selector,input') || selector);
      return { opened: true, text: item.text.slice(0, 180) };
    }
    return null;
  }, {
    fieldPatterns: regexSources(fieldLabels),
    optionPatterns: regexSources(optionLabels)
  });
  if (opened?.selectedNative) {
    if (waitAfterMs) await sleep(waitAfterMs);
    return opened;
  }
  if (opened) await sleep(500);
  const option = await clickWinitText(page, optionLabels, { waitAfterMs });
  return option || null;
}

async function fillWinitField(page, selectors, value, hints = [], timeout = 8000) {
  const filled = await fillBySelector(page, selectors, value, timeout);
  if (filled) return true;
  if (!hints.length) return false;
  return fillFirstMatchingInput(page, value, hints);
}

async function typeWinitInput(page, selector, value) {
  return page.evaluate(({ targetSelector, nextValue }) => {
    const input = document.querySelector(targetSelector);
    if (!input) return false;
    const prototype = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    const setValue = next => {
      const tracker = input._valueTracker;
      if (tracker) tracker.setValue(input.value);
      if (setter) setter.call(input, next);
      else input.value = next;
    };
    input.focus();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    setValue('');
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    setValue(String(nextValue));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: String(nextValue) }));
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(nextValue) }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(nextValue) }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    input.blur?.();
    return true;
  }, { targetSelector: selector, nextValue: value }).catch(() => false);
}

async function clickWinitSearchButton(page) {
  return page.evaluate(() => {
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
    const button = Array.from(document.querySelectorAll('button,.winitd-btn,.ant-btn'))
      .filter(visible)
      .find(item => (item.innerText || item.textContent || '').replace(/\s+/g, '') === '查询');
    if (!button) return false;
    fire(button);
    return true;
  }).catch(() => false);
}

async function resetWinitSender(page, waitAfterMs = 800) {
  const reset = await evaluateInWinitFrames(page, sourcePatterns => {
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
    const buttons = Array.from(document.querySelectorAll('button,a,[role="button"],.ant-btn,.winitd-btn,input[type="button"]'))
      .filter(visible)
      .map(element => ({
        element,
        text: (element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim(),
        context: (element.closest('.ant-form-item,.winitd-form-item,.ant-card,.winitd-card,section,form,div')?.innerText || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(item => /重置|Reset/i.test(item.text) && regexes.some(regex => regex.test(`${item.text} ${item.context}`)))
      .sort((left, right) => left.context.length - right.context.length);
    const button = buttons[0];
    if (!button) return null;
    fire(button.element);
    return { text: button.text };
  }, regexSources([/发件人|寄件人|sender/i, /重置发件人|重置寄件人|Reset Sender/i]));
  if (reset) {
    if (waitAfterMs) await sleep(waitAfterMs);
    return reset;
  }
  return clickWinitText(page, [/重置发件人|重置寄件人|Reset Sender/i], { waitAfterMs });
}

async function clickWinitNext(page, waitAfterMs = 2500) {
  const clicked = await clickByText(page, [/^下一步$/, /^Next$/i], { waitAfterMs });
  if (clicked) return { text: '下一步' };
  return clickWinitText(page, [/^下一步$/, /^Next$/i], { waitAfterMs });
}

async function waitForWinitText(page, patterns, timeout = 15000) {
  const regexes = (Array.isArray(patterns) ? patterns : [patterns])
    .map(pattern => pattern instanceof RegExp ? pattern : new RegExp(escapeRegExp(pattern), 'i'));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await pageText(page);
    if (regexes.some(regex => regex.test(text))) return true;
    await sleep(500);
  }
  return false;
}

async function winitMainText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => pageText(page));
}

async function gotoWinitReturnPage(page) {
  if (!page.url().includes('/ReturnOrders/stepOneNewWH')) {
    await page.goto(WINIT_RETURN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(error => {
      if (!page.url().includes('/ReturnOrders/stepOneNewWH')) throw error;
    });
  }
  await waitForWinitText(page, [/创建退货单|基本信息|Return\s*Label/i], 15000);
}

async function selectWinitSelectByInputId(page, inputId, optionLabels, waitAfterMs = 1000) {
  const labelList = (Array.isArray(optionLabels) ? optionLabels : [optionLabels]).filter(Boolean);
  const selected = await evaluateInWinitFrames(page, async ({ targetInputId, plainLabels, sourcePatterns }) => {
    const regexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const fire = element => {
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const textOf = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    const input = document.querySelector(`#${CSS.escape(targetInputId)}`);
    const select = input?.closest('.winitd-select,.ant-select');
    if (!select || !visible(select)) return null;
    fire(select.querySelector('.winitd-select-selector,.ant-select-selector,input') || select);
    let options = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      options = Array.from(document.querySelectorAll('.winitd-select-item-option,.ant-select-item-option,[role="option"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: textOf(element),
          title: element.getAttribute('title') || ''
        }))
        .filter(item => item.text || item.title);
      if (options.length) break;
    }
    const exact = options.find(item => plainLabels.some(label => item.text === label || item.title === label));
    const regexMatch = options.find(item => regexes.some(regex => regex.test(`${item.title} ${item.text}`)));
    const option = exact || regexMatch || options[0];
    if (!option) return null;
    fire(option.element);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const selectedText = textOf(select);
    return {
      text: option.text || option.title,
      selectedText,
      options: options.map(item => item.text || item.title).slice(0, 20)
    };
  }, {
    targetInputId: inputId,
    plainLabels: labelList.filter(label => typeof label === 'string'),
    sourcePatterns: regexSources(labelList)
  });
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

function winitSelectionMatches(result, optionLabels) {
  if (!result) return false;
  const labels = (Array.isArray(optionLabels) ? optionLabels : [optionLabels]).filter(Boolean);
  const selectedText = compactText([result.selectedText, result.text, result.title, result.aria].filter(Boolean).join(' '));
  if (!selectedText) return false;
  const selectedWithoutPlaceholder = compactText(selectedText.replace(/请选择|please\s*select/ig, ''));
  if (!selectedWithoutPlaceholder) return false;
  return labels.some(label => {
    if (label instanceof RegExp) return label.test(selectedText);
    return includesQuery(selectedText, label);
  });
}

async function readWinitSelectState(page, inputId) {
  return evaluateInWinitFrames(page, targetInputId => {
    const input = document.querySelector(`#${CSS.escape(targetInputId)}`);
    const select = input?.closest('.winitd-select,.ant-select');
    if (!select) return null;
    const textOf = element => (element?.innerText || element?.textContent || element?.value || '').replace(/\s+/g, ' ').trim();
    const selected = select.querySelector('.winitd-select-selection-item,.ant-select-selection-item');
    const placeholder = select.querySelector('.winitd-select-selection-placeholder,.ant-select-selection-placeholder');
    return {
      inputId: targetInputId,
      value: input.value || '',
      text: textOf(selected) || textOf(select),
      title: selected?.getAttribute('title') || '',
      selectedText: [
        selected?.getAttribute('title'),
        textOf(selected),
        textOf(placeholder),
        textOf(select)
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    };
  }, inputId);
}

async function selectWinitFirstOptionByInputId(page, inputId, waitAfterMs = 1000) {
  const selected = await evaluateInWinitFrames(page, async targetInputId => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const textOf = element => (element?.innerText || element?.textContent || element?.value || '').replace(/\s+/g, ' ').trim();
    const fire = element => {
      if (!element) return;
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const currentSelection = select => [
      select.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.getAttribute('title'),
      select.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.innerText,
      select.innerText,
      select.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const input = document.querySelector(`#${CSS.escape(targetInputId)}`);
    const select = input?.closest('.winitd-select,.ant-select');
    if (!select || !visible(select)) return null;
    fire(select.querySelector('.winitd-select-selector,.ant-select-selector,input') || select);
    let options = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(150);
      options = Array.from(document.querySelectorAll('.winitd-select-dropdown:not(.winitd-select-dropdown-hidden) .winitd-select-item-option,.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option,[role="option"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: textOf(element),
          title: element.getAttribute('title') || '',
          aria: element.getAttribute('aria-label') || ''
        }))
        .filter(item => {
          const text = `${item.text || ''} ${item.title || ''} ${item.aria || ''}`.replace(/\s+/g, ' ').trim();
          return text && !/请选择|please\s*select/i.test(text);
        });
      if (options.length) break;
    }
    const option = options[0];
    if (!option) return null;
    fire(option.element.querySelector('.winitd-select-item-option-content,.ant-select-item-option-content') || option.element);
    await delay(1000);
    return {
      text: option.text || option.title || option.aria,
      selectedText: currentSelection(select),
      options: options.map(item => item.text || item.title || item.aria).slice(0, 20),
      fallbackFirstOption: true
    };
  }, inputId);
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function selectWinitSearchableByInputId(page, inputId, optionLabels, waitAfterMs = 1000) {
  const labelList = (Array.isArray(optionLabels) ? optionLabels : [optionLabels]).filter(Boolean);
  const plainLabels = labelList.filter(label => typeof label === 'string').map(label => String(label).trim()).filter(Boolean);
  const selected = await evaluateInWinitFrames(page, async ({ targetInputId, plainLabels, sourcePatterns }) => {
    const regexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const textOf = element => (element?.innerText || element?.textContent || element?.value || '').replace(/\s+/g, ' ').trim();
    const fire = element => {
      if (!element) return;
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const setInputValue = (input, nextValue) => {
      if (!input) return false;
      const prototype = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      input.focus?.();
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (setter) setter.call(input, nextValue);
      else input.value = nextValue;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: nextValue.slice(-1) || '' }));
      return true;
    };
    const matches = item => {
      const text = `${item.title || ''} ${item.aria || ''} ${item.text || ''}`;
      return plainLabels.some(label => item.text === label || item.title === label || item.aria === label || text.includes(label)) ||
        regexes.some(regex => regex.test(text));
    };
    const currentSelection = select => [
      select.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.getAttribute('title'),
      select.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.innerText,
      select.innerText,
      select.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const input = document.querySelector(`#${CSS.escape(targetInputId)}`);
    const select = input?.closest('.winitd-select,.ant-select');
    if (!select || !visible(select)) return null;
    fire(select.querySelector('.winitd-select-selector,.ant-select-selector,input') || select);
    await delay(300);

    const searchText = plainLabels[0] || '';
    const searchInput = select.querySelector('input:not([type="hidden"])') ||
      document.querySelector('.winitd-select-dropdown:not(.winitd-select-dropdown-hidden) input,.ant-select-dropdown:not(.ant-select-dropdown-hidden) input') ||
      input;
    if (searchText && searchInput) {
      setInputValue(searchInput, searchText);
      await delay(900);
    }

    let options = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(150);
      options = Array.from(document.querySelectorAll('.winitd-select-dropdown:not(.winitd-select-dropdown-hidden) .winitd-select-item-option,.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option,[role="option"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: textOf(element),
          title: element.getAttribute('title') || '',
          aria: element.getAttribute('aria-label') || ''
        }))
        .filter(item => item.text || item.title || item.aria);
      if (options.some(matches)) break;
    }

    const option = options.find(matches);
    if (option) {
      fire(option.element.querySelector('.winitd-select-item-option-content,.ant-select-item-option-content') || option.element);
      await delay(1000);
      return {
        text: option.text || option.title || option.aria,
        selectedText: currentSelection(select),
        options: options.map(item => item.text || item.title || item.aria).slice(0, 20)
      };
    }

    if (searchInput) {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      await delay(800);
      return {
        text: searchText,
        selectedText: currentSelection(select),
        options: options.map(item => item.text || item.title || item.aria).slice(0, 20),
        pressedEnter: true
      };
    }
    return null;
  }, {
    targetInputId: inputId,
    plainLabels,
    sourcePatterns: regexSources(labelList)
  });
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function selectWinitMainSelectByInputId(page, inputId, optionLabels, waitAfterMs = 1000) {
  const labelList = (Array.isArray(optionLabels) ? optionLabels : [optionLabels]).filter(Boolean);
  const selected = await page.evaluate(async ({ targetInputId, plainLabels, sourcePatterns }) => {
    const regexes = sourcePatterns.map(item => new RegExp(item.source, item.flags));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const fire = element => {
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const Pointer = window.PointerEvent || window.MouseEvent;
      element.dispatchEvent(new Pointer('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new Pointer('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      element.click();
    };
    const textOf = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    const input = document.querySelector(`#${CSS.escape(targetInputId)}`);
    const select = input?.closest('.winitd-select,.ant-select');
    if (!select || !visible(select)) return null;
    fire(select.querySelector('.winitd-select-selector,.ant-select-selector') || select);
    input.focus?.();
    let options = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100);
      options = Array.from(document.querySelectorAll('.winitd-select-dropdown:not(.winitd-select-dropdown-hidden) .winitd-select-item-option,.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option,[role="option"]'))
        .filter(visible)
        .map(element => ({
          element,
          text: textOf(element),
          title: element.getAttribute('title') || '',
          aria: element.getAttribute('aria-label') || ''
        }))
        .filter(item => item.text || item.title || item.aria);
      if (options.length) break;
    }
    const exact = options.find(item => plainLabels.some(label => item.text === label || item.title === label || item.aria === label));
    const regexMatch = options.find(item => regexes.some(regex => regex.test(`${item.title} ${item.aria} ${item.text}`)));
    const option = exact || regexMatch || options[0];
    if (!option) return null;
    fire(option.element);
    await delay(1000);
    return {
      text: option.text || option.title || option.aria,
      selectedText: textOf(select),
      options: options.map(item => item.text || item.title || item.aria).slice(0, 20)
    };
  }, {
    targetInputId: inputId,
    plainLabels: labelList.filter(label => typeof label === 'string'),
    sourcePatterns: regexSources(labelList)
  }).catch(() => null);
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function fillWinitReturnQuantities(page, quantity) {
  const desiredQuantity = Math.max(1, Number(quantity) || DEFAULT_RETURN_QUANTITY);
  const result = await evaluateInWinitFrames(page, value => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const setValue = (input, nextValue) => {
      const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, String(nextValue));
      else input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea'))
      .filter(input => visible(input) && !input.disabled && !input.readOnly)
      .map(input => {
        const context = [
          input.placeholder,
          input.name,
          input.id,
          input.getAttribute('aria-label'),
          input.closest('label')?.innerText,
          input.closest('.ant-form-item,.winitd-form-item')?.innerText,
          input.closest('td')?.innerText,
          input.closest('tr')?.innerText,
          input.closest('[role="row"]')?.innerText
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        let score = 0;
        if (/退货数量|退件数量|退回数量|Return\s*(Qty|Quantity)|Qty/i.test(context)) score += 12;
        if (/数量/.test(context)) score += 6;
        if (/table|row|td/i.test(input.closest('table,tr,[role="row"]')?.tagName || '') || input.closest('tr,[role="row"]')) score += 3;
        if (input.type === 'number' || input.inputMode === 'numeric') score += 2;
        if (/重量|长|宽|高|体积|邮编|电话|手机|价格|费用|邮箱|地址|RMA/i.test(context)) score -= 20;
        return { input, context, score };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score);
    const strong = inputs.filter(item => item.score >= 10);
    const targets = strong.length ? strong : inputs.slice(0, 1);
    const filled = [];
    for (const item of targets) {
      const max = Number(item.input.max || item.input.getAttribute('max'));
      const nextValue = Number.isFinite(max) && max > 0 ? Math.min(value, max) : value;
      setValue(item.input, nextValue);
      filled.push({ value: String(nextValue), context: item.context.slice(0, 180) });
    }
    return filled.length ? { count: filled.length, filled } : null;
  }, desiredQuantity);
  return result || { count: 0, filled: [] };
}

async function selectWinitLogisticsProduct(page, waitAfterMs = 1000, preferredQuote = null) {
  const selected = await evaluateInWinitFrames(page, ({ primaryPatterns, fallbackPatterns }) => {
    const primary = primaryPatterns.map(item => new RegExp(item.source, item.flags));
    const fallback = fallbackPatterns.map(item => new RegExp(item.source, item.flags));
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
    const textOf = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    const rowSelectors = [
      'tr',
      '[role="row"]',
      '.ant-table-row',
      '.winitd-table-row',
      '.ant-list-item',
      '.winitd-list-item',
      '.ant-card',
      '.winitd-card',
      '.ant-radio-wrapper',
      '.winitd-radio-wrapper',
      'label'
    ];
    const rows = Array.from(document.querySelectorAll(rowSelectors.join(',')))
      .filter(visible)
      .map(element => ({ element, text: textOf(element) }))
      .filter(item => item.text && /(物流|Return|Parcel|AU\s*Post|eParcel|费用|推荐|官方)/i.test(item.text));
    const exact = rows
      .filter(item => primary.some(regex => regex.test(item.text)))
      .sort((left, right) => left.text.length - right.text.length);
    const loose = rows
      .filter(item => fallback.some(regex => regex.test(item.text)) || (/推荐|官方/.test(item.text) && /Return|物流|快递|Parcel/i.test(item.text)))
      .sort((left, right) => left.text.length - right.text.length);
    const match = exact[0] || loose[0];
    if (!match) return null;
    const control = match.element.querySelector('input[type="radio"],input[type="checkbox"],.ant-radio,.winitd-radio,.ant-checkbox,.winitd-checkbox,button');
    fire(control || match.element);
    return { text: match.text.slice(0, 260) };
  }, {
    primaryPatterns: regexSources([
      preferredQuote?.code,
      preferredQuote?.name,
      /AU\s*Post[\s\S]{0,220}Parcel\s*Post[\s\S]{0,220}eParcel\s*Return\s*Service[\s\S]{0,120}AU/i
    ]),
    fallbackPatterns: regexSources([/AU\s*Post/i, /eParcel\s*Return\s*Service/i, /Parcel\s*Post/i])
  });
  if (selected && waitAfterMs) await sleep(waitAfterMs);
  return selected;
}

async function clickWinitFinalSubmit(page) {
  const clicked = await clickByText(page, [/^提交$/, /^确认提交$/, /保存并提交|创建退货单|Submit/i], { waitAfterMs: 2500 });
  const finalClick = clicked || await clickWinitText(page, [/^提交$/, /^确认提交$/, /保存并提交|创建退货单|Submit/i], { waitAfterMs: 2500 });
  if (!finalClick) return null;
  await clickWinitText(page, [/^确定$/, /^确认$/, /^OK$/i], { waitAfterMs: 2500 }).catch(() => {});
  return finalClick;
}

function parseWinitReturnResult(text, order) {
  const source = String(text || '');
  const returnOrderNo = source.match(/\bRT\d{6,}[A-Z]{0,4}\b/i)?.[0] || '';
  const rmaNo =
    source.match(/(?:RMA|RMA号|RMA\s*No\.?)[^\dA-Z]{0,20}([A-Z0-9-]{6,})/i)?.[1] ||
    source.match(/RMA[\s\S]{0,60}?\b(\d{6,})\b/i)?.[1] ||
    '';
  const excluded = new Set([
    returnOrderNo,
    order?.trackingNo,
    order?.warehouseOrderNo,
    order?.stOrderNo
  ].filter(Boolean).map(value => String(value).toUpperCase()));
  const trackingCandidates = extractWinitTrackingNumbers(source).filter(candidate => {
    const normalized = String(candidate).toUpperCase();
    if (excluded.has(normalized)) return false;
    if (/^RT\d/i.test(normalized) || /^WO\d/i.test(normalized) || /^SO\d/i.test(normalized)) return false;
    return true;
  });
  const trackingNo =
    trackingCandidates.find(candidate => /^\d{2,4}[A-Z]{1,4}\d{8,}/i.test(candidate)) ||
    trackingCandidates[0] ||
    '';
  return {
    returnOrderNo,
    trackingNo,
    rmaNo,
    trackingCandidates
  };
}

async function selectWinitKeyword(page, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  for (const frame of page.frames()) {
    const selected = await withTimeout(frame.evaluate(async wantedLabels => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const input = document.querySelector('#keyword');
      const selector = input?.closest('.winitd-select') || input?.closest('.ant-select');
      if (!selector) return false;
      const fire = element => {
        element.scrollIntoView?.({ block: 'center', inline: 'center' });
        const Pointer = window.PointerEvent || window.MouseEvent;
        element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, view: window }));
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        element.click();
      };
      fire(selector.querySelector('.winitd-select-selector, .ant-select-selector') || selector);
      await new Promise(resolve => setTimeout(resolve, 500));
      const options = Array.from(document.querySelectorAll('.winitd-select-item-option, .ant-select-item-option, [role="option"]'))
        .filter(visible);
      const option = options.find(item => {
        const text = (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim();
        const title = item.getAttribute('title') || '';
        return wantedLabels.some(label => title === label || text === label || text.includes(label));
      });
      if (!option) return false;
      fire(option.querySelector('.winitd-select-item-option-content,.ant-select-item-option-content') || option);
      await new Promise(resolve => setTimeout(resolve, 500));
      const selectedText = [
        selector.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.getAttribute('title'),
        selector.querySelector('.winitd-select-selection-item,.ant-select-selection-item')?.innerText,
        selector.innerText,
        selector.textContent
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      return wantedLabels.some(label => selectedText.includes(label));
    }, labelList).catch(() => false), 5000, false);
    if (selected) return true;
  }
  return false;
}

async function fetchWinitOrderByTracking(page, query) {
  const response = await page.evaluate(async trackingNo => {
    const form = new URLSearchParams();
    form.set('sEcho', '1');
    form.set('iDisplayStart', '0');
    form.set('iDisplayLength', '20');
    form.set('aSorting[0][sName]', '');
    form.set('aSorting[0][sValue]', '');
    form.set('api', 'wh_outbound_getOrderList');
    form.set('jsondata', 'true');
    form.set('form', JSON.stringify({ trackingNo, reqSource: 'NEW' }));
    const res = await fetch('/App/ajaxProcess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: form.toString(),
      credentials: 'include'
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }, query).catch(error => ({ ok: false, status: 0, text: '', error: error.message }));

  if (!response.ok) {
    return {
      platform: 'winit',
      query,
      found: false,
      source: 'winit-page-request',
      message: `万邑通同页查询请求失败：${response.status || response.error || 'unknown'}`
    };
  }
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    return {
      platform: 'winit',
      query,
      found: false,
      source: 'winit-page-request',
      message: '万邑通同页查询返回不是 JSON'
    };
  }
  const records = Array.isArray(payload.aoData) ? payload.aoData : [];
  const parsed = records.map(record => parseWinitOrderRecord(record, query)).find(Boolean);
  if (parsed) return parsed;
  return {
    platform: 'winit',
    query,
    found: false,
    source: 'winit-page-request',
    message: '万邑通同页查询未匹配到跟踪号',
    rawTextSnippet: compactText(response.text).slice(0, 2000)
  };
}

async function winitPageRequest(page, api, formPayload = {}, endpoint = '/ReturnOrders/ajaxProcess') {
  const response = await page.evaluate(async ({ apiName, formPayload: payload, endpointPath }) => {
    const form = new URLSearchParams();
    form.set('api', apiName);
    form.set('jsondata', 'true');
    form.set('form', JSON.stringify(payload || {}));
    const res = await fetch(endpointPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: form.toString(),
      credentials: 'include'
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }, {
    apiName: api,
    formPayload,
    endpointPath: endpoint
  }).catch(error => ({ ok: false, status: 0, text: '', error: error.message }));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.error || `HTTP ${response.status || 'unknown'}`,
      text: response.text || ''
    };
  }

  try {
    return {
      ok: true,
      status: response.status,
      payload: JSON.parse(response.text),
      text: response.text
    };
  } catch {
    return {
      ok: false,
      status: response.status,
      error: 'Winit response is not JSON',
      text: response.text || ''
    };
  }
}

function collectWinitObjects(value, predicate, limit = 80, depth = 0, output = []) {
  if (output.length >= limit || depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectWinitObjects(item, predicate, limit, depth + 1, output);
    return output;
  }
  if (typeof value !== 'object') return output;
  if (predicate(value)) output.push(value);
  for (const item of Object.values(value)) {
    collectWinitObjects(item, predicate, limit, depth + 1, output);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeWinitPackageInfo(raw, order = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const packageNo =
    raw.packageNo ||
    raw.shippingNo ||
    raw.packageCode ||
    raw.orderPackageNo ||
    raw.outboundPackageNo ||
    '';
  const warehouseCode =
    raw.warehouseCode ||
    raw.orderWarehouseCode ||
    raw.shipWarehouseCode ||
    order.warehouseCode ||
    '';
  const customerOrderNo =
    raw.customerOrderNo ||
    raw.sellerOrderNo ||
    raw.referenceNo ||
    order.customerOrderNo ||
    order.sellerOrderNo ||
    order.stOrderNo ||
    '';
  const storeType =
    raw.storeType ||
    raw.orderStoreType ||
    raw.platformStoreType ||
    order.storeType ||
    'other';
  const buyerCountryCode =
    raw.buyerCountryCode ||
    raw.countryCode ||
    raw.receiverCountryCode ||
    raw.consigneeCountryCode ||
    order.address?.countryCode ||
    order.countryCode ||
    '';
  const buyerState =
    raw.buyerState ||
    raw.state ||
    raw.receiverState ||
    raw.consigneeState ||
    order.address?.state ||
    order.state ||
    '';
  const buyerCity =
    raw.buyerCity ||
    raw.city ||
    raw.receiverCity ||
    raw.consigneeCity ||
    order.address?.city ||
    order.city ||
    '';
  const buyerPostcode =
    raw.buyerPostcode ||
    raw.postcode ||
    raw.zipCode ||
    raw.zipcode ||
    raw.postCode ||
    raw.post_code ||
    raw.receiverPostcode ||
    raw.receiverZipCode ||
    raw.consigneePostcode ||
    order.address?.postcode ||
    order.address?.zipCode ||
    order.postcode ||
    order.zipCode ||
    '';
  return {
    packageNo,
    shippingNo: packageNo,
    warehouseCode,
    warehouseName: raw.warehouseName || raw.orderWarehouseName || order.warehouse || '',
    customerOrderNo,
    sellerOrderNo: customerOrderNo,
    storeType,
    productCode: raw.productCode || raw.sku || raw.merchandiseCode || order.productCode || '',
    productName: raw.productName || raw.merchandiseName || raw.name || '',
    buyerCountryCode,
    buyerState,
    buyerCity,
    buyerPostcode,
    rawTextSnippet: compactText(JSON.stringify(raw)).slice(0, 2500)
  };
}

function pickWinitPackageInfo(payload, order = {}) {
  const outboundOrderNo = order.warehouseOrderNo || order.outboundOrderNo || '';
  const objects = collectWinitObjects(payload, item =>
    Boolean(
      item.packageNo ||
      item.shippingNo ||
      item.customerOrderNo ||
      item.sellerOrderNo ||
      item.warehouseCode
    )
  );
  const scored = objects.map(raw => {
    const info = normalizeWinitPackageInfo(raw, order);
    if (!info) return null;
    const haystack = compactText(JSON.stringify(raw));
    let score = 0;
    if (info.packageNo) score += 8;
    if (info.warehouseCode) score += 5;
    if (info.customerOrderNo) score += 4;
    if (outboundOrderNo && includesQuery(haystack, outboundOrderNo)) score += 12;
    if (order.stOrderNo && includesQuery(haystack, order.stOrderNo)) score += 8;
    if (order.trackingNo && includesQuery(haystack, order.trackingNo)) score += 6;
    return { info, score };
  }).filter(Boolean);
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.info || null;
}

async function fetchWinitPackageList(page, outboundOrderNo, order = {}) {
  if (!outboundOrderNo) {
    return {
      ok: false,
      packageInfo: null,
      message: '缺少万邑通出库单号，无法查询包裹信息'
    };
  }
  const form = { orderNo: outboundOrderNo };
  const primary = await winitPageRequest(page, 'wh.outbound.getPackageList', form, '/ReturnOrders/ajaxProcess');
  const fallback = primary.ok ? null : await winitPageRequest(page, 'wh.outbound.getPackageList', form, '/App/ajaxProcess');
  const response = primary.ok ? primary : fallback;
  if (!response?.ok) {
    return {
      ok: false,
      packageInfo: null,
      message: `万邑通包裹信息查询失败：${primary.error || fallback?.error || 'unknown'}`,
      rawTextSnippet: compactText(primary.text || fallback?.text || '').slice(0, 2000)
    };
  }
  const packageInfo = pickWinitPackageInfo(response.payload, { ...order, warehouseOrderNo: outboundOrderNo });
  return {
    ok: Boolean(packageInfo),
    packageInfo,
    source: 'winit-page-request',
    message: packageInfo ? '万邑通包裹信息已通过网页后端接口获取' : '万邑通包裹接口返回中未解析到包裹号',
    rawTextSnippet: compactText(JSON.stringify(response.payload)).slice(0, 3000)
  };
}

function buildWinitReturnUrl(order, packageInfo = {}) {
  const outboundOrderNo = order.warehouseOrderNo || order.outboundOrderNo || '';
  const params = new URLSearchParams();
  if (outboundOrderNo) params.set('outboundOrderNo', outboundOrderNo);
  if (packageInfo.warehouseCode || order.warehouseCode) {
    params.set('warehouseCode', packageInfo.warehouseCode || order.warehouseCode);
  }
  if (packageInfo.shippingNo || packageInfo.packageNo || order.packageNo) {
    params.set('shippingNo', packageInfo.shippingNo || packageInfo.packageNo || order.packageNo);
  }
  if (packageInfo.customerOrderNo || order.customerOrderNo || order.sellerOrderNo || order.stOrderNo) {
    params.set(
      'sellerOrderNo',
      packageInfo.customerOrderNo || order.customerOrderNo || order.sellerOrderNo || order.stOrderNo
    );
  }
  if (packageInfo.storeType || order.storeType) {
    params.set('storeType', packageInfo.storeType || order.storeType);
  }
  const query = params.toString();
  return query ? `${WINIT_RETURN_URL}?${query}` : WINIT_RETURN_URL;
}

async function readWinitPrefillState(page) {
  return page.evaluate(() => {
    const readInput = id => {
      const input = document.querySelector(`#${CSS.escape(id)}`);
      return input ? String(input.value || '').trim() : '';
    };
    const selectText = id => {
      const input = document.querySelector(`#${CSS.escape(id)}`);
      const select = input?.closest('.winitd-select,.ant-select');
      return (select?.innerText || select?.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const shippingText = bodyText.match(/出库子单号\s+([A-Z0-9-]+)/i)?.[1] || '';
    const selectedWarehouseText = selectText('warehouseCode');
    const warehouseText =
      (selectedWarehouseText && !/请选择/.test(selectedWarehouseText) ? selectedWarehouseText : '') ||
      bodyText.match(/收货仓\s+(.+?)\s+退货策略/)?.[1] ||
      '';
    return {
      isWinitOutbound: Boolean(document.querySelector('input[type="radio"][value="Y"]')?.checked),
      returnLabelChecked: Boolean(document.querySelector('#isReturnLabel')?.checked),
      outboundOrderNo: readInput('outboundOrderNo'),
      shippingNo: readInput('shippingNo') || shippingText,
      customerOrderNo: readInput('customerOrderNo'),
      customerExpressNo: readInput('customerExpressNo'),
      warehouseCode: readInput('warehouseCode'),
      warehouseText,
      bodySnippet: bodyText.slice(0, 2500)
    };
  }).catch(() => null);
}

async function waitForWinitPrefillState(page, outboundOrderNo, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await readWinitPrefillState(page);
    if (
      state?.outboundOrderNo ||
      (outboundOrderNo && includesQuery(state?.bodySnippet, outboundOrderNo) && (state?.customerOrderNo || state?.shippingNo))
    ) {
      return state;
    }
    await sleep(400);
  }
  return state || await readWinitPrefillState(page);
}

async function ensureWinitReturnLabelYes(page, waitAfterMs = 800) {
  const checked = await setWinitCheckboxById(page, 'isReturnLabel', true, waitAfterMs);
  if (checked?.checked) return checked;
  const fallback = await page.evaluate(() => {
    const input = document.querySelector('#isReturnLabel');
    if (!input) return null;
    if (!input.checked && !input.disabled) {
      input.click();
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { id: input.id, checked: input.checked, disabled: input.disabled };
  }).catch(() => null);
  if (fallback && waitAfterMs) await sleep(waitAfterMs);
  return fallback;
}

async function readWinitReturnFormData(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const read = id => document.querySelector(`#${CSS.escape(id)}`)?.value || '';
    const textOf = selector => (document.querySelector(selector)?.innerText || document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const parseCountry = value => {
      const text = String(value || '');
      if (/英国|United Kingdom|\bGB\b/i.test(text)) return 'GB';
      if (/澳大利亚|Australia|\bAU\b/i.test(text)) return 'AU';
      if (/德国|Germany|\bDE\b/i.test(text)) return 'DE';
      if (/美国|United States|\bUS\b/i.test(text)) return 'US';
      if (/加拿大|Canada|\bCA\b/i.test(text)) return 'CA';
      return '';
    };
    const sku = bodyText.match(/\b\d{4,}-[A-Z0-9-]+\b/i)?.[0] || '';
    return {
      outboundOrderNo: read('outboundOrderNo'),
      shippingNo: read('shippingNo'),
      customerOrderNo: read('customerOrderNo'),
      warehouseCode: read('warehouseCode'),
      warehouseText: textOf('#warehouseCode'),
      sku,
      products: sku ? [{ sku, warehouseSku: sku, quantity: Number(bodyText.match(/\bQty[:：]?\s*(\d+)/i)?.[1]) || 1 }] : [],
      address: {
        countryCode: parseCountry(bodyText),
        state: read('buyerState') || read('state'),
        city: read('buyerCity') || read('city'),
        postcode: read('buyerPostcode') || read('post_code'),
        rawTextSnippet: bodyText.slice(0, 1600)
      },
      rawTextSnippet: bodyText.slice(0, 2500)
    };
  }).catch(() => ({ products: [], address: {} }));
}

async function findWinitOrder({ trackingNo }) {
  const query = trackingNo;
  if (!query) {
    return {
      platform: 'winit',
      found: false,
      message: '缺少易仓跟踪号，跳过万邑通查询'
    };
  }
  const page = await gotoPlatform('winit', config.urls.winit);
  await loginIfNeeded(page, 'winit');
  if (!page.url().includes('/WHOutbound')) {
    await page.goto(config.urls.winit, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await sleep(2500);

  const backendFirst = await fetchWinitOrderByTracking(page, query);
  if (backendFirst.found) {
    backendFirst.keywordSelected = 'backend-first';
    return backendFirst;
  }

  await clickByText(page, [/重置/], { waitAfterMs: 500 });
  const keywordSelected = await selectWinitKeyword(page, ['快递单号']);
  const filled = await typeWinitInput(page, '#keywordValue', query) || await fillBySelector(page, ['#keywordValue'], query);
  if (!filled) {
    return {
      platform: 'winit',
      query,
      found: false,
      message: '万邑通跟踪号查询输入框未找到'
    };
  }
  const clicked = await clickWinitSearchButton(page);
  if (!clicked) await page.keyboard.press('Enter').catch(() => {});
  await sleep(3500);
  const rows = await rowsContaining(page, query);
  const parsed = parseWinitOrderText(await pageText(page), query, rows);
  parsed.keywordSelected = keywordSelected;
  if (parsed.found) return parsed;

  const fallback = await fetchWinitOrderByTracking(page, query);
  fallback.keywordSelected = keywordSelected;
  fallback.uiRawTextSnippet = parsed.rawTextSnippet;
  return fallback;
}

function normalizeWinitCreateOptions(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const strategy = String(source.stockStrategy || source.strategy || source.returnStrategy || 'photo-hold').trim();
  return {
    stockStrategy: ['photo-hold', 'direct-shelve', 'destroy'].includes(strategy) ? strategy : 'photo-hold',
    templateType: String(source.templateType || source.photoTemplateType || 'WINIT标准模板-开箱').trim() || 'WINIT标准模板-开箱'
  };
}

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

function packageAddressFallback(packageInfo = {}) {
  const raw = packageInfo.raw || {};
  return {
    countryCode: firstNonEmpty(packageInfo.buyerCountryCode, raw.buyerCountryCode, raw.countryCode),
    state: firstNonEmpty(packageInfo.buyerState, raw.buyerState, raw.state),
    city: firstNonEmpty(packageInfo.buyerCity, raw.buyerCity, raw.city),
    postcode: firstNonEmpty(packageInfo.buyerPostcode, raw.buyerPostcode, raw.postcode, raw.zipCode, raw.zipcode, raw.postCode, raw.post_code)
  };
}

function normalizeWinitAddressForQuote(...sources) {
  return sources.reduce((address, source = {}) => mergeNonEmpty(address, {
    countryCode: firstNonEmpty(source.countryCode, source.country),
    state: firstNonEmpty(source.state, source.regionName),
    city: firstNonEmpty(source.city),
    postcode: firstNonEmpty(source.postcode, source.zipCode, source.zipcode, source.postCode, source.post_code, source.buyerPostcode),
    rawTextSnippet: source.rawTextSnippet
  }), {});
}

function winitStrategyOptionLabels(strategy) {
  if (strategy === 'destroy') return [/销毁/];
  if (strategy === 'direct-shelve') return [/直接上架/];
  return [/拍照暂存/];
}

function winitProcessTypeLabels(strategy) {
  if (strategy === 'destroy') return [/销毁/];
  if (strategy === 'direct-shelve') return [/直接上架|良品上架/];
  return [/拍照暂存|暂存/];
}

function winitStrategyName(strategy) {
  if (strategy === 'destroy') return '销毁';
  if (strategy === 'direct-shelve') return '直接上架';
  return '拍照暂存';
}

async function selectWinitTemplateType(page, templateType) {
  const labels = [/WINIT拍照模版类型|WINIT拍照模板类型|拍照模版类型|拍照模板类型|模板类型/i];
  const attempts = [
    () => selectWinitSearchableByInputId(page, 'photoTemplateType', [templateType], 800),
    () => selectWinitMainSelectByInputId(page, 'photoTemplateType', [templateType], 800),
    () => selectWinitSelectByInputId(page, 'photoTemplateType', [templateType], 800),
    () => selectWinitDropdown(page, labels, [templateType], 800)
  ];
  let lastResult = null;
  for (const attempt of attempts) {
    const result = await attempt();
    if (result) lastResult = result;
    const state = await readWinitSelectState(page, 'photoTemplateType').catch(() => null);
    if (winitSelectionMatches(state, [templateType])) {
      return { ...(state || result || {}), verified: true };
    }
    if (winitSelectionMatches(result, [templateType])) {
      return { ...result, verified: true };
    }
  }
  if (templateType) {
    await fillFirstMatchingInput(page, templateType, labels).catch(() => false);
    const retried = await clickWinitText(page, [templateType], { waitAfterMs: 800 });
    const finalState = await readWinitSelectState(page, 'photoTemplateType').catch(() => null);
    if (winitSelectionMatches(finalState, [templateType])) {
      return { ...(finalState || retried || {}), verified: true };
    }
    if (retried) return { ...retried, verified: false, selectedText: finalState?.selectedText || retried.text || '' };
  }
  const fallback = await selectWinitFirstOptionByInputId(page, 'photoTemplateType', 800);
  const fallbackState = await readWinitSelectState(page, 'photoTemplateType').catch(() => null);
  if (fallback && winitSelectionMatches(fallbackState || fallback, [fallback.text])) {
    return {
      ...(fallbackState || fallback),
      text: fallback.text,
      requestedText: templateType,
      fallbackFirstOption: true,
      verified: true
    };
  }
  return lastResult ? { ...lastResult, verified: false } : null;
}

async function createWinitReturn({
  order,
  dryRun = true,
  allowCreate = false,
  shippingQuote = null,
  preferCrawlerOnly = config.preferCrawlerOnly,
  winitOptions = {}
}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);
  page.__platformKey = 'winit';
  if (!page.__winitReturnDialogHandlerAttached) {
    page.__winitReturnDialogHandlerAttached = true;
    page.on('dialog', async dialog => {
      await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
    });
  }
  await gotoWinitReturnPage(page);
  await loginIfNeeded(page, 'winit');
  if (!page.url().includes('/ReturnOrders/stepOneNewWH')) {
    await gotoWinitReturnPage(page);
  }

  const outboundOrderNo = order.warehouseOrderNo || '';
  if (!outboundOrderNo) {
    return {
      platform: 'winit',
      dryRun,
      created: false,
      message: '万邑通退货单需要出库单号，当前未匹配到'
    };
  }

  const stepStatus = {};
  stepStatus.packageLookup = await fetchWinitPackageList(page, outboundOrderNo, order);
  const packageInfo = stepStatus.packageLookup.packageInfo || {};
  const returnUrl = buildWinitReturnUrl({ ...order, warehouseOrderNo: outboundOrderNo }, packageInfo);
  if (returnUrl !== page.url()) {
    await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitForWinitText(page, [/WINIT\s*出库|创建退货单|基本信息|Return\s*Label/i], 15000);
  }

  const requestedWarehouse = order.warehouse || packageInfo.warehouseName || 'AU Warehouse';
  const returnQuantity = order.returnQuantity || order.returnQty || order.quantity || order.qty || DEFAULT_RETURN_QUANTITY;
  const resolvedWinitOptions = normalizeWinitCreateOptions(winitOptions || order.winitOptions || {});
  const fallbackAddress = packageAddressFallback(packageInfo);
  stepStatus.prefillUrl = returnUrl;
  stepStatus.overlaysDismissed = await dismissWinitOverlays(page);
  stepStatus.returnLabel = await ensureWinitReturnLabelYes(page, 800);
  stepStatus.prefillState = await waitForWinitPrefillState(page, outboundOrderNo, 12000);
  stepStatus.formData = await readWinitReturnFormData(page);
  stepStatus.winitCreateOptions = resolvedWinitOptions;
  stepStatus.quoteAddress = normalizeWinitAddressForQuote(
    order.address || {},
    order,
    fallbackAddress,
    stepStatus.formData.address || {}
  );
  const quote = shippingQuote?.candidates?.length
    ? shippingQuote
    : await calculateWinitShipping({
      ...order,
      ...stepStatus.formData,
      packageInfo,
      products: stepStatus.formData.products?.length ? stepStatus.formData.products : order.products,
      address: stepStatus.quoteAddress,
      postcode: firstNonEmpty(stepStatus.quoteAddress.postcode, order.postcode, order.zipCode),
      zipCode: firstNonEmpty(stepStatus.quoteAddress.postcode, order.zipCode)
    }, page).catch(error => ({
      platform: 'winit',
      quoted: false,
      candidates: [],
      selected: null,
      message: error.message
    }));
  if (!allowCreate || dryRun || preferCrawlerOnly) {
    const crawlerOnlyBlocked = Boolean(allowCreate && !dryRun && preferCrawlerOnly);
    return {
      platform: 'winit',
      dryRun,
      created: false,
      needsReview: crawlerOnlyBlocked,
      crawlerOnlyBlocked,
      packageInfo,
      stepStatus,
      shippingQuote: quote,
      selectedLogistics: quote.selected,
      logisticsCandidates: (quote.candidates || []).slice(0, 8),
      rawTextSnippet: compactText(stepStatus.prefillState?.bodySnippet || await winitMainText(page)).slice(0, 4000),
      message: crawlerOnlyBlocked
        ? 'Crawler-only 模式已阻止 UI 向导提交：万邑通真实创建还需要完整复刻 firstStep/secondStep/submitPSC/submitUserInfo 后端写入链路。'
        : 'Dry-run: 已用万邑通网页后端接口获取包裹信息，并打开带参数的退货页核验预填；未点击“下一步”或其它创建步骤。'
    };
  }

  await waitForWinitText(page, [/WINIT\s*出库/i], 10000);
  stepStatus.winitOutbound =
    await clickWinitInputByValue(page, 'radio', 'Y', 1200) ||
    await setWinitMainControlValue(page, { type: 'radio', value: 'Y', waitAfterMs: 1200 }) ||
    await setWinitControlValue(page, { type: 'radio', value: 'Y', waitAfterMs: 1000 }) ||
    await setWinitChoice(page, [/^WINIT\s*出库$/i, /^WINIT\s*outbound$/i], { kind: 'radio', waitAfterMs: 500 }) ||
    await clickSelector(page, ['input[type="radio"][value="Y"]'], 5000, 500);
  stepStatus.winitBranchReady = await waitForWinitSelector(page, '#outboundOrderNo', 8000);
  if (!stepStatus.winitBranchReady) {
    return {
      platform: 'winit',
      dryRun,
      created: false,
      needsReview: true,
      stepStatus,
      message: '万邑通页面未切换到 WINIT 出库分支，已停止后续填单以避免走错流程。',
      rawTextSnippet: compactText(await winitMainText(page)).slice(0, 3000)
    };
  }
  stepStatus.returnLabel = await ensureWinitReturnLabelYes(page, 800);

  stepStatus.outboundFilled = await fillWinitField(
    page,
    ['#outboundOrderNo', 'input[name="outboundOrderNo"]'],
    outboundOrderNo,
    [/出库单|出库订单|Outbound/i],
    10000
  );
  if (order.trackingNo) {
    stepStatus.customerExpressFilled = await fillWinitField(
      page,
      ['#customerExpressNo', 'input[name="customerExpressNo"]'],
      order.trackingNo,
      [/快递单号|跟踪号|Tracking/i],
      2000
    );
  }
  await page.keyboard.press('Tab').catch(() => {});
  await sleep(1200);

  stepStatus.warehouseSelected = requestedWarehouse
    ? await selectWinitMainSelectByInputId(page, 'warehouseCode', [requestedWarehouse, /^AU\s*Warehouse$/i], 1000) ||
      await selectWinitSelectByInputId(page, 'warehouseCode', [requestedWarehouse, /^AU\s*Warehouse$/i], 1000) ||
      await selectWinitDropdown(page, [/仓库|Warehouse|下单仓|出货仓|收货仓/i], [requestedWarehouse, /^AU\s*Warehouse$/i], 1000)
    : null;
  const strategyLabels = winitStrategyOptionLabels(resolvedWinitOptions.stockStrategy);
  const strategyName = winitStrategyName(resolvedWinitOptions.stockStrategy);
  stepStatus.stockStrategy =
    await selectWinitDropdown(page, [/退货策略|策略|入库策略|上架策略|处理策略/i], strategyLabels, 800) ||
    await setWinitChoice(page, strategyLabels, { waitAfterMs: 800 }) ||
    await clickByText(page, strategyLabels, { waitAfterMs: 800 });
  if (!winitSelectionMatches(stepStatus.stockStrategy, strategyLabels)) {
    return {
      platform: 'winit',
      dryRun,
      created: false,
      needsReview: true,
      stepStatus,
      shippingQuote: quote,
      selectedLogistics: quote.selected,
      logisticsCandidates: (quote.candidates || []).slice(0, 8),
      rawTextSnippet: compactText(await winitMainText(page)).slice(0, 4000),
      message: `万邑通退货策略未确认选中“${strategyName}”，已停止提交以避免生成错误退货策略。`
    };
  }
  if (resolvedWinitOptions.stockStrategy === 'photo-hold') {
    stepStatus.photoTemplateType =
      await selectWinitTemplateType(page, resolvedWinitOptions.templateType) ||
      await setWinitChoice(page, [resolvedWinitOptions.templateType], { waitAfterMs: 800 }) ||
      await clickByText(page, [resolvedWinitOptions.templateType], { waitAfterMs: 800 });
    if (!stepStatus.photoTemplateType?.verified) {
      return {
        platform: 'winit',
        dryRun,
        created: false,
        needsReview: true,
        stepStatus,
        shippingQuote: quote,
        selectedLogistics: quote.selected,
        logisticsCandidates: (quote.candidates || []).slice(0, 8),
        rawTextSnippet: compactText(await winitMainText(page)).slice(0, 4000),
        message: `万邑通拍照暂存模板未确认选中：${resolvedWinitOptions.templateType}`
      };
    }
  }
  stepStatus.senderResetStepOne = await resetWinitSender(page, 800);

  stepStatus.prefillState = await readWinitPrefillState(page);

  stepStatus.nextAfterStepOne = await clickWinitNext(page, 4000);
  await waitForWinitText(page, [/退货数量|退件数量|Return\s*(Qty|Quantity)|商品信息|SKU/i], 12000);
  stepStatus.quantity = await fillWinitReturnQuantities(page, returnQuantity);
  const processTypeLabels = winitProcessTypeLabels(resolvedWinitOptions.stockStrategy);
  stepStatus.processType =
    await selectWinitMainSelectByInputId(page, 'handleMethod', processTypeLabels, 800) ||
    await selectWinitSelectByInputId(page, 'handleMethod', processTypeLabels, 800) ||
    await selectWinitDropdown(page, [/处理方式|处理类型|货品处理|处置方式|上架方式|退货策略/i], processTypeLabels, 800) ||
    await setWinitChoice(page, processTypeLabels, { waitAfterMs: 800 }) ||
    await clickByText(page, processTypeLabels, { waitAfterMs: 800 });
  if (!winitSelectionMatches(stepStatus.processType, processTypeLabels)) {
    return {
      platform: 'winit',
      dryRun,
      created: false,
      needsReview: true,
      stepStatus,
      shippingQuote: quote,
      selectedLogistics: quote.selected,
      logisticsCandidates: (quote.candidates || []).slice(0, 8),
      rawTextSnippet: compactText(await winitMainText(page)).slice(0, 4000),
      message: `万邑通 SKU 处理方式未确认选中“${strategyName}”，已停止提交以避免生成错误退货策略。`
    };
  }

  stepStatus.nextAfterStepTwo = await clickWinitNext(page, 5000);
  await waitForWinitText(page, [/物流产品|官方物流|AU\s*Post|eParcel|Return\s*Service|费用|总费用/i], 15000);
  stepStatus.logisticsSelected = await selectWinitLogisticsProduct(page, 1200, quote.selected);

  const logisticsText = await winitMainText(page);
  const candidates = parseWinitLogisticsCandidates(logisticsText);
  const selected =
    matchCandidateByText(quote.candidates || [], stepStatus.logisticsSelected?.text || '') ||
    quote.selected ||
    candidates.find(candidate => /AU\s*Post|eParcel\s*Return\s*Service/i.test(candidate.name)) ||
    candidates.find(candidate => Number.isFinite(candidate.price)) ||
    null;

  stepStatus.nextAfterStepThree = await clickWinitNext(page, 5000);
  await waitForWinitText(page, [/提交|发件人|寄件人|Return\s*Label|总费用|费用/i], 12000);
  stepStatus.senderResetStepFour = await resetWinitSender(page, 800);

  const reviewText = await winitMainText(page);
  const result = {
    platform: 'winit',
    dryRun,
    winitCreateOptions: resolvedWinitOptions,
    stepStatus,
    shippingQuote: quote,
    selectedLogistics: selected,
    logisticsCandidates: (quote.candidates?.length ? quote.candidates : candidates).slice(0, 8),
    rawTextSnippet: compactText(`${logisticsText}\n${reviewText}`).slice(0, 4000)
  };

  if (!allowCreate || dryRun) {
    result.created = false;
    result.message = 'Dry-run: filled return label steps and skipped final Submit.';
    return result;
  }

  const submitted = await clickWinitFinalSubmit(page);
  if (!submitted) {
    result.created = false;
    result.message = '万邑通退货单最终提交按钮未找到或不可点击';
    result.rawTextSnippet = compactText(await pageText(page)).slice(0, 4000);
    return result;
  }
  await sleep(5000);
  const afterText = await pageText(page);
  const parsed = parseWinitReturnResult(afterText, order);
  result.created = Boolean(parsed.returnOrderNo);
  result.returnOrderNo = parsed.returnOrderNo;
  result.trackingNo = parsed.trackingNo;
  result.rmaNo = parsed.rmaNo;
  result.trackingCandidates = parsed.trackingCandidates;
  result.rawTextSnippet = compactText(afterText).slice(0, 4000);
  return result;
}

async function probeWinit() {
  const page = await gotoPlatform('winit', config.urls.winit);
  const login = await loginIfNeeded(page, 'winit');
  return {
    platform: 'winit',
    login,
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: compactText(await pageText(page)).slice(0, 1000)
  };
}

module.exports = {
  createWinitReturn,
  findWinitOrder,
  parseWinitOrderText,
  parseWinitLogisticsCandidates,
  probeWinit
};
