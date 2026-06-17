const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../env');

const DEFAULT_TIMEOUT_MS = 30000;

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function md5(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === undefined) return '';
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeJsonValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = normalizeJsonValue(value[key]);
    return acc;
  }, {});
}

function sortedJsonString(value) {
  if (value == null) return '';
  return JSON.stringify(normalizeJsonValue(value));
}

function isBlank(value) {
  return value === undefined || value === null || String(value) === '';
}

function firstNonEmpty(...values) {
  return values.find(value => !isBlank(value)) || '';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function includesQuery(text, query) {
  if (!query) return false;
  return compactText(text).toUpperCase().includes(compactText(query).toUpperCase());
}

function numericAmount(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

function chooseCheapest(candidates = []) {
  return candidates
    .filter(item => Number.isFinite(Number(item.price)))
    .sort((left, right) => Number(left.price) - Number(right.price))[0] || null;
}

function extractTrackingNumbers(text) {
  const source = String(text || '');
  const patterns = [
    /\b[A-Z]{1,4}\d{8,}[A-Z]{0,4}\b/g,
    /\b\d{10,30}\b/g,
    /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g
  ];
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

async function fetchJson(url, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return {
      ok: res.ok,
      status: res.status,
      json,
      text
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: '',
      error: error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function apiSuccess(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.ask && /^success$/i.test(String(json.ask))) return true;
  if (json.code === 0 || json.code === '0' || json.code === 200 || json.code === '200') return true;
  if (json.status === 1 || json.status === '1' || json.success === true) return true;
  return false;
}

function apiMessage(json, fallback = '') {
  return firstNonEmpty(
    json?.message,
    json?.msg,
    json?.error?.errMessage,
    json?.Error?.errMessage,
    json?.error_msg,
    fallback
  );
}

function collectObjects(value, predicate, limit = 120, depth = 0, output = []) {
  if (output.length >= limit || depth > 10 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, predicate, limit, depth + 1, output);
    return output;
  }
  if (typeof value !== 'object') return output;
  if (predicate(value)) output.push(value);
  for (const item of Object.values(value)) {
    collectObjects(item, predicate, limit, depth + 1, output);
    if (output.length >= limit) break;
  }
  return output;
}

function safeSnippet(value, max = 2000) {
  return compactText(typeof value === 'string' ? value : JSON.stringify(value || {})).slice(0, max);
}

function ensureLabelDir(platform) {
  const dir = path.join(config.moduleDir, '.runtime', 'labels', platform);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionFromLabelType(labelType = '', fallback = 'pdf') {
  const text = String(labelType || '').toLowerCase();
  if (text.includes('png') || text === '1') return 'png';
  if (text.includes('jpg') || text.includes('jpeg')) return 'jpg';
  if (text.includes('pdf') || text === '2') return 'pdf';
  return fallback;
}

function saveBase64Label(platform, orderNo, labelBase64, labelType = '') {
  if (!labelBase64) return null;
  const dir = ensureLabelDir(platform);
  const bytes = Buffer.from(String(labelBase64).replace(/^data:[^,]+,/, ''), 'base64');
  const magic = bytes.subarray(0, 8).toString('latin1');
  const fallback =
    magic.startsWith('%PDF') ? 'pdf' :
    magic.startsWith('\x89PNG') ? 'png' :
    magic.startsWith('\xff\xd8') ? 'jpg' :
    'pdf';
  const extension = extensionFromLabelType(labelType, fallback);
  const safeOrderNo = String(orderNo || `label-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_');
  const fileName = `${safeOrderNo}.${extension}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, bytes);
  return {
    fileName,
    filePath,
    downloadUrl: `/api/labels/${encodeURIComponent(platform)}/${encodeURIComponent(fileName)}`
  };
}

module.exports = {
  apiMessage,
  apiSuccess,
  asArray,
  chooseCheapest,
  collectObjects,
  compactText,
  extractTrackingNumbers,
  fetchJson,
  firstNonEmpty,
  includesQuery,
  isBlank,
  md5,
  numericAmount,
  safeSnippet,
  saveBase64Label,
  sortedJsonString,
  stableStringify
};
