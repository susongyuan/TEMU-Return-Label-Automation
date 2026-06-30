const state = {
  job: null,
  results: [],
  pollTimer: null,
  eventSource: null,
  pollStartedAt: 0,
  realCreateMaxPerJob: 1,
  orderConcurrency: 5,
  preferCrawlerOnly: true,
  activeView: 'create',
  historyPlatform: 'all',
  historyKeyword: '',
  historyRecords: [],
  historyTotal: 0,
  quoteAbortController: null,
  quoteRunId: 0,
  retryMergeJobId: null
};

const els = {
  ordersInput: document.querySelector('#ordersInput'),
  dryRun: document.querySelector('#dryRun'),
  allowCreate: document.querySelector('#allowCreate'),
  winitStockStrategies: document.querySelectorAll('input[name="winitStockStrategy"]'),
  winitTemplateType: document.querySelector('#winitTemplateType'),
  runBtn: document.querySelector('#runBtn'),
  probeBtn: document.querySelector('#probeBtn'),
  exportBtn: document.querySelector('#exportBtn'),
  statusbar: document.querySelector('#statusbar'),
  resultsBody: document.querySelector('#resultsBody'),
  inputCount: document.querySelector('#inputCount'),
  riskNotice: document.querySelector('#riskNotice'),
  summaryGrid: document.querySelector('#summaryGrid'),
  flowPanel: document.querySelector('#flowPanel'),
  modePill: document.querySelector('#modePill'),
  viewTabs: document.querySelectorAll('[data-view-tab]'),
  createView: document.querySelector('#createView'),
  historyView: document.querySelector('#historyView'),
  historyBody: document.querySelector('#historyBody'),
  historyMeta: document.querySelector('#historyMeta'),
  historyRefreshBtn: document.querySelector('#historyRefreshBtn'),
  historySearch: document.querySelector('#historySearch'),
  historyPlatformBtns: document.querySelectorAll('[data-history-platform]'),
  quoteDrawerToggle: document.querySelector('#quoteDrawerToggle'),
  quoteDrawerClose: document.querySelector('#quoteDrawerClose'),
  quoteDrawer: document.querySelector('#quoteDrawer'),
  quoteOverlay: document.querySelector('#quoteOverlay'),
  quoteOrderInput: document.querySelector('#quoteOrderInput'),
  quotePlatformSelect: document.querySelector('#quotePlatformSelect'),
  quotePostcodeInput: document.querySelector('#quotePostcodeInput'),
  quoteRunBtn: document.querySelector('#quoteRunBtn'),
  quoteStopBtn: document.querySelector('#quoteStopBtn'),
  quoteStatus: document.querySelector('#quoteStatus'),
  quoteResult: document.querySelector('#quoteResult')
};

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(['finished', 'completed', 'complete', 'done', 'success', 'succeeded', 'failed', 'error', 'cancelled']);
const OPERATOR_STORAGE_KEY = 'temuDashboardOperator';

const STATUS_META = {
  preview: ['待预检', 'tag--queued'],
  queued: ['待处理', 'tag--queued'],
  pending: ['待处理', 'tag--queued'],
  processing: ['处理中', 'tag--progress'],
  running: ['处理中', 'tag--progress'],
  matching: ['匹配中', 'tag--progress'],
  matched: ['已匹配', ''],
  creating: ['创建中', 'tag--progress'],
  dryrun: ['预检完成', 'tag--created'],
  'dry-run': ['预检完成', 'tag--created'],
  skipped: ['已跳过', 'tag--review'],
  'needs-review': ['需复核', 'tag--review'],
  review: ['需复核', 'tag--review'],
  created: ['已创建', 'tag--created'],
  finished: ['已完成', 'tag--created'],
  completed: ['已完成', 'tag--created'],
  complete: ['已完成', 'tag--created'],
  done: ['已完成', 'tag--created'],
  success: ['成功', 'tag--created'],
  succeeded: ['成功', 'tag--created'],
  failed: ['失败', 'tag--failed'],
  error: ['失败', 'tag--failed'],
  cancelled: ['已取消', 'tag--failed']
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPayload(json) {
  return json?.data ?? json;
}

function getJobPayload(jsonOrPayload) {
  const payload = getPayload(jsonOrPayload);
  return payload?.job ?? payload?.task ?? payload;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text } };
  }
}

function errorMessage(json, fallback) {
  return firstValue(json?.error?.message, json?.message, json?.error, fallback);
}

function storedOperatorPayload() {
  try {
    const stored = JSON.parse(localStorage.getItem(OPERATOR_STORAGE_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return {};
    return {
      authToken: stored.authToken || '',
      operatorKey: stored.operatorKey || '',
      operatorName: stored.operatorName || ''
    };
  } catch {
    return {};
  }
}

function getSelectedWinitStockStrategy() {
  return Array.from(els.winitStockStrategies || []).find(input => input.checked)?.value || 'photo-hold';
}

function collectWinitOptions() {
  return {
    stockStrategy: getSelectedWinitStockStrategy(),
    templateType: String(els.winitTemplateType?.value || 'WINIT标准模板-开箱').trim() || 'WINIT标准模板-开箱'
  };
}

function updateWinitOptionsUi() {
  const strategy = getSelectedWinitStockStrategy();
  const needsTemplate = strategy === 'photo-hold';
  if (els.winitTemplateType) {
    els.winitTemplateType.disabled = !needsTemplate;
  }
}

function hydrateOperatorFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const handoff = String(params.get('handoff') || '').trim();
    if (!handoff) return;
    fetch('/api/return-label/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffCode: handoff })
    })
      .then(response => response.json().then(payload => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || '登录态交换失败');
        const operatorKey = String(payload.data?.operatorKey || '').trim();
        const operatorName = String(payload.data?.operatorName || '').trim();
        if (!operatorKey || !operatorName) throw new Error('登录态交换失败');
        localStorage.setItem(OPERATOR_STORAGE_KEY, JSON.stringify({
          authToken: '',
          operatorKey,
          operatorName
        }));
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      })
      .catch(error => {
        alert(error.message);
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      });
  } catch {
    // Keep the existing local operator state if the handoff URL is malformed.
  }
}

function formatBeijingTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

function platformLabel(platform) {
  const text = String(platform || '');
  if (/goodcang|gucang|谷仓/i.test(text)) return '谷仓';
  if (/winit|万邑通/i.test(text)) return '万邑通';
  if (/4px/i.test(text)) return '4PX';
  return text || '未知';
}

function normalizeStOrder(rawOrderNo) {
  const raw = String(rawOrderNo || '').trim().replace(/\s+/g, '');
  if (!raw) return '';
  const withoutPrefix = raw.replace(/^ST-/i, '');
  const withoutSplitSuffix = withoutPrefix.replace(/-D\d{2}$/i, '');
  return `ST-${withoutSplitSuffix}`;
}

function splitInputLines(input) {
  return String(input || '')
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean);
}

function normalizeReturnMode(mode, trackingNo, carrierName) {
  const explicit = String(mode || '').trim().toLowerCase();
  if (['custom', 'self', 'manual', '自选', '自寄'].includes(explicit)) return 'custom';
  if (['auto', 'platform', 'official', '平台', '官方', '代选'].includes(explicit)) return 'auto';
  return trackingNo || carrierName ? 'custom' : 'auto';
}

function parseOrderLine(line) {
  if (line && typeof line === 'object') {
    const rawOrderNo = firstValue(line.rawOrderNo, line.raw, line.poOrderNo, line.poNo, line.orderNo, line.input, line.stOrderNo, '');
    const customerReturnTrackingNo = firstValue(
      line.customerReturnTrackingNo,
      line.returnTrackingNo,
      line.returnExpressNo,
      line.expressNo,
      ''
    );
    const customerReturnCarrierName = firstValue(
      line.customerReturnCarrierName,
      line.returnCarrierName,
      line.preferredReturnCourier,
      line.returnCourier,
      line.courier,
      line.supplierName,
      line.returnSupplierName,
      ''
    );
    const returnLogisticsMode = normalizeReturnMode(firstValue(line.returnLogisticsMode, line.logisticsMode, ''), customerReturnTrackingNo, customerReturnCarrierName);
    return {
      ...line,
      rawOrderNo,
      stOrderNo: firstValue(line.stOrderNo, normalizeStOrder(rawOrderNo)),
      customerReturnTrackingNo,
      returnExpressNo: customerReturnTrackingNo,
      customerReturnCarrierName,
      preferredReturnCourier: customerReturnCarrierName,
      returnCourier: customerReturnCarrierName,
      supplierName: customerReturnCarrierName,
      returnSupplierName: customerReturnCarrierName,
      returnLogisticsMode
    };
  }

  const text = String(line || '').trim();
  const parts = text.split(/[,，\t ]+/).map(item => item.trim()).filter(Boolean);
  const rawOrderNo = parts[0] || '';
  const customerReturnTrackingNo = parts[1] || '';
  const customerReturnCarrierName = parts.slice(2).join(' ');
  const returnLogisticsMode = normalizeReturnMode('', customerReturnTrackingNo, customerReturnCarrierName);
  return {
    rawOrderNo,
    stOrderNo: normalizeStOrder(rawOrderNo),
    customerReturnTrackingNo,
    returnExpressNo: customerReturnTrackingNo,
    customerReturnCarrierName,
    preferredReturnCourier: customerReturnCarrierName,
    returnCourier: customerReturnCarrierName,
    supplierName: customerReturnCarrierName,
    returnSupplierName: customerReturnCarrierName,
    returnLogisticsMode,
    inputLine: text
  };
}

function getInputOrders() {
  return splitInputLines(els.ordersInput?.value || '')
    .map(parseOrderLine)
    .filter(order => order.rawOrderNo);
}

function composeOrderLine(order) {
  return [
    order.rawOrderNo,
    order.customerReturnTrackingNo || order.returnExpressNo,
    order.customerReturnCarrierName || order.supplierName
  ].filter(Boolean).join(' ');
}

function getPreviewRows() {
  const orders = getInputOrders();
  const counts = orders.reduce((acc, order) => {
    const stOrderNo = order.stOrderNo || normalizeStOrder(order.rawOrderNo);
    acc[stOrderNo] = (acc[stOrderNo] || 0) + 1;
    return acc;
  }, {});

  return orders.map(order => {
    const stOrderNo = order.stOrderNo || normalizeStOrder(order.rawOrderNo);
    const duplicated = counts[stOrderNo] > 1;
    return {
      ...order,
      status: duplicated ? 'needs-review' : 'preview',
      error: duplicated ? '重复订单，提交前请确认。' : ''
    };
  });
}

function normalizeOrder(order) {
  if (typeof order === 'string') {
    return {
      rawOrderNo: order,
      stOrderNo: normalizeStOrder(order)
    };
  }

  const rawOrderNo = firstValue(order?.rawOrderNo, order?.raw, order?.poOrderNo, order?.poNo, order?.orderNo, order?.input, order?.stOrderNo);
  const customerReturnTrackingNo = firstValue(order?.customerReturnTrackingNo, order?.returnTrackingNo, order?.returnExpressNo, order?.expressNo, '');
  const customerReturnCarrierName = firstValue(
    order?.customerReturnCarrierName,
    order?.returnCarrierName,
    order?.preferredReturnCourier,
    order?.returnCourier,
    order?.courier,
    order?.supplierName,
    order?.returnSupplierName,
    ''
  );
  return {
    ...order,
    rawOrderNo,
    stOrderNo: firstValue(order?.stOrderNo, order?.standardOrderNo, order?.stNo, normalizeStOrder(rawOrderNo)),
    customerReturnTrackingNo,
    returnExpressNo: customerReturnTrackingNo,
    customerReturnCarrierName,
    preferredReturnCourier: customerReturnCarrierName,
    returnCourier: customerReturnCarrierName,
    supplierName: customerReturnCarrierName,
    returnSupplierName: customerReturnCarrierName,
    returnLogisticsMode: normalizeReturnMode(firstValue(order?.returnLogisticsMode, order?.logisticsMode, ''), customerReturnTrackingNo, customerReturnCarrierName)
  };
}

function normalizeJob(job) {
  const source = job || {};
  const orders = asArray(source.orders).map(normalizeOrder);
  const results = asArray(source.results).map(normalizeOrder);

  return {
    ...source,
    id: firstValue(source.id, source.jobId, source.taskId),
    status: firstValue(source.status, source.state, 'queued'),
    orders,
    results
  };
}

function getDisplayRows() {
  if (state.results.length) return state.results;
  if (state.job?.results?.length) return state.job.results;
  if (state.job?.orders?.length) {
    return state.job.orders.map(order => ({
      ...order,
      status: order.status || state.job.status || 'queued'
    }));
  }
  return getPreviewRows();
}

function statusMeta(status) {
  const key = String(status || '').trim();
  return STATUS_META[key] || STATUS_META[key.toLowerCase()] || [key || '待处理', 'tag--queued'];
}

function statusTag(status) {
  const [label, cls] = statusMeta(status);
  return `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
}

function displayStatus(row) {
  if (row?.displayStatus) return row.displayStatus;
  const key = String(row?.status || '').toLowerCase();
  const creation = row?.returnCreation || {};
  if (creation.dryRun || (key === 'done' && !getReturnOrderNo(row) && !getLabelNo(row))) {
    return 'dry-run';
  }
  if (key === 'done' && (getReturnOrderNo(row) || getLabelNo(row))) {
    return 'created';
  }
  return row?.status;
}

function rowClass(status) {
  const key = String(status || '').toLowerCase();
  if (['failed', 'error', 'cancelled'].includes(key)) return 'is-failed';
  if (['needs-review', 'review', 'skipped'].includes(key)) return 'is-review';
  return '';
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

function getLastStepMessage(row) {
  const steps = asArray(row.steps);
  const last = steps[steps.length - 1];
  return firstValue(last?.message, last?.name, '');
}

function getCustomerReturnTrackingNo(row) {
  const creation = row.returnCreation || {};
  const preview = creation.createPayloadPreview || {};
  return firstValue(
    row.customerReturnTrackingNo,
    row.returnExpressNo,
    row.returnTrackingNo,
    preview.expressNo,
    creation.customerReturnTrackingNo,
    ''
  );
}

function getCustomerReturnCarrierName(row) {
  const creation = row.returnCreation || {};
  const preview = creation.createPayloadPreview || {};
  return firstValue(
    row.customerReturnCarrierName,
    row.returnCarrierName,
    row.preferredReturnCourier,
    row.returnCourier,
    row.courier,
    row.supplierName,
    row.returnSupplierName,
    creation.customerReturnCarrierName,
    preview.supplierName,
    preview.courier,
    ''
  );
}

function getReturnLogisticsMode(row) {
  const creation = row.returnCreation || {};
  return normalizeReturnMode(
    firstValue(row.returnLogisticsMode, creation.returnLogisticsMode, ''),
    getCustomerReturnTrackingNo(row),
    getCustomerReturnCarrierName(row)
  );
}

function getWarehouseSource(row) {
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  const source = firstValue(
    row.warehouseSource,
    row.warehousePlatform,
    row.platform,
    warehouse.source,
    warehouse.platform,
    eccang.source,
    eccang.platform
  );

  if (!source) return '';
  const text = String(source);
  if (/谷仓|gucang|goodcang/i.test(text)) return '谷仓';
  if (/万邑通|winit/i.test(text)) return '万邑通';
  return text;
}

function getWarehouseOrderNo(row) {
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  return firstValue(
    row.warehouseOrderNo,
    warehouse.warehouseOrderNo,
    warehouse.orderNo,
    warehouse.id,
    eccang.warehouseOrderNo,
    eccang.orderNo
  );
}

function getTrackingNo(row) {
  const creation = row.returnCreation || {};
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  return firstValue(
    row.trackingNo,
    row.trackNo,
    creation.trackingNo,
    creation.trackNo,
    eccang.trackingNo,
    warehouse.trackingNo,
    asArray(warehouse.trackingNumbers)[0]
  );
}

function getReturnOrderNo(row) {
  const creation = row.returnCreation || {};
  return firstValue(row.returnOrderNo, creation.returnOrderNo, creation.orderNo, creation.id);
}

function getLabelNo(row) {
  const creation = row.returnCreation || {};
  return firstValue(
    row.labelNo,
    row.waybillNo,
    creation.labelNo,
    creation.labelId,
    creation.waybillNo,
    creation.shippingLabelNo,
    creation.trackingNo,
    creation.trackNo,
    creation.labelInfo?.trackingNo,
    creation.labelInfo?.labelNo
  );
}

function getLabelDownload(row) {
  const creation = row.returnCreation || {};
  const file = firstValue(row.labelFile, creation.labelFile);
  const url = firstValue(
    row.labelDownloadUrl,
    row.downloadUrl,
    file?.downloadUrl,
    creation.labelDownloadUrl,
    creation.downloadUrl,
    creation.labelFile?.downloadUrl
  );
  const name = firstValue(file?.fileName, creation.labelFile?.fileName, getLabelNo(row), getReturnOrderNo(row), '下载面单');
  return url ? { url, name } : null;
}

function normalizeCandidate(candidate) {
  if (typeof candidate === 'string') {
    return {
      name: candidate,
      code: '',
      price: '',
      currency: 'CNY',
      selected: true
    };
  }

  if (!candidate || typeof candidate !== 'object') return null;

  const name = firstValue(
    candidate.name,
    candidate.channelName,
    candidate.logisticsName,
    candidate.serviceName,
    candidate.shippingMethod,
    candidate.provider,
    candidate.code,
    candidate.channelCode
  );
  const code = firstValue(candidate.code, candidate.channelCode, candidate.serviceCode);
  const price = firstValue(candidate.price, candidate.fee, candidate.amount, candidate.cost, candidate.totalFee);
  const currency = firstValue(candidate.currency, candidate.currencyCode, 'CNY');

  return {
    name: name || code || '未命名渠道',
    code,
    price,
    currency,
    selected: Boolean(candidate.selected || candidate.isSelected || candidate.isCheapest || candidate.cheapest)
  };
}

function getCandidates(row) {
  const creation = row.returnCreation || {};
  const pools = [
    row.logisticsCandidates,
    row.candidateLogistics,
    row.logisticsOptions,
    row.shippingOptions,
    row.candidates,
    creation.logisticsCandidates,
    creation.candidateLogistics,
    creation.logisticsOptions,
    creation.shippingOptions,
    creation.candidates
  ];
  return (pools.find(Array.isArray) || []).map(normalizeCandidate).filter(Boolean);
}

function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function formatMoney(value, currency = 'CNY') {
  if (value === undefined || value === null || value === '') return '待报价';
  const number = parsePrice(value);
  if (!Number.isFinite(number)) return String(value);
  const code = String(currency || 'CNY').toUpperCase();
  if (code === 'CNY' || code === 'RMB' || code === '¥') return `¥${number.toFixed(2)}`;
  return `${code} ${number.toFixed(2)}`;
}

function findCheapestCandidate(candidates) {
  return candidates
    .filter(candidate => Number.isFinite(parsePrice(candidate.price)))
    .sort((a, b) => parsePrice(a.price) - parsePrice(b.price))[0];
}

function compareCandidatesByPrice(left, right) {
  const leftPrice = parsePrice(left.price);
  const rightPrice = parsePrice(right.price);
  const leftHasPrice = Number.isFinite(leftPrice);
  const rightHasPrice = Number.isFinite(rightPrice);
  if (leftHasPrice && rightHasPrice) return leftPrice - rightPrice;
  if (leftHasPrice) return -1;
  if (rightHasPrice) return 1;
  return 0;
}

function getSelectedLogistics(row) {
  const creation = row.returnCreation || {};
  const explicit = normalizeCandidate(firstValue(
    row.selectedLogistics,
    row.cheapestLogistics,
    creation.selectedLogistics,
    creation.cheapestLogistics
  ));
  if (explicit) return explicit;

  const candidates = getCandidates(row);
  return candidates.find(candidate => candidate.selected) || findCheapestCandidate(candidates);
}

function getQuoteMessage(row) {
  const creation = row.returnCreation || {};
  const quote = firstValue(row.shippingQuote, creation.shippingQuote);
  return firstValue(
    quote?.message,
    creation.stepStatus?.shippingQuoteMessage,
    row.stepStatus?.shippingQuoteMessage
  );
}

function sameLogistics(left, right) {
  if (!left || !right) return false;
  if (left.code && right.code) return left.code === right.code;
  return left.name === right.name && String(left.price ?? '') === String(right.price ?? '');
}

function rowIdentity(row = {}) {
  return firstValue(row.stOrderNo, row.rawOrderNo ? normalizeStOrder(row.rawOrderNo) : '', row.rawOrderNo, '');
}

function findDisplayRowByKey(key) {
  const target = String(key || '').trim();
  if (!target) return null;
  return getDisplayRows().find(row =>
    rowIdentity(row) === target ||
    row.rawOrderNo === target ||
    row.stOrderNo === target
  ) || null;
}

function mergeDisplayRows(baseRows = [], incomingRows = []) {
  const rows = baseRows.length ? [...baseRows] : [];
  for (const incoming of incomingRows) {
    const key = rowIdentity(incoming);
    const index = rows.findIndex(row => rowIdentity(row) === key);
    if (index >= 0) rows[index] = { ...rows[index], ...incoming };
    else rows.push(incoming);
  }
  return rows;
}

function canManualSelectLogistics(row) {
  const status = String(displayStatus(row) || row.status || '').toLowerCase();
  const reviewStatus = ['needs-review', 'review', 'failed', 'error'].includes(status);
  const source = `${getWarehouseSource(row)} ${row.platform || ''}`;
  return reviewStatus && /谷仓|goodcang/i.test(source) && getCandidates(row).length > 0;
}

function renderEccangMatch(row) {
  const orderNo = getWarehouseOrderNo(row);
  const trackingNo = getTrackingNo(row);
  const source = getWarehouseSource(row);
  const matched = firstValue(row.eccang?.matched, row.matched);

  if (matched === false || row.status === 'failed' || row.status === 'error') {
    return '<span class="error-text">未匹配</span>';
  }

  if (orderNo || trackingNo || matched === true) {
    const detail = [orderNo, trackingNo].filter(Boolean).join(' / ');
    return `
      <span class="strong-text">已匹配</span>
      ${detail ? `<br><span class="mono muted-text">${escapeHtml(detail)}</span>` : ''}
      ${source ? `<br><span class="muted-text">${escapeHtml(source)}</span>` : ''}
    `;
  }

  return '<span class="muted-text">待匹配</span>';
}

function renderWarehouse(row) {
  const source = getWarehouseSource(row);
  const orderNo = getWarehouseOrderNo(row);
  if (!source && !orderNo) return '<span class="muted-text">未返回</span>';
  return `
    <span class="strong-text">${escapeHtml(source || '未知来源')}</span>
    ${orderNo ? `<br><span class="mono muted-text">${escapeHtml(orderNo)}</span>` : ''}
  `;
}

function renderCustomerReturnTracking(row) {
  const value = getCustomerReturnTrackingNo(row);
  const carrierName = getCustomerReturnCarrierName(row);
  const mode = getReturnLogisticsMode(row);
  const source = getWarehouseSource(row);
  if (mode === 'custom') {
    const detail = [value, carrierName].filter(Boolean).join(' / ');
    return `
      <span class="strong-text">自选物流</span>
      ${detail ? `<br><span class="mono muted-text">${escapeHtml(detail)}</span>` : '<br><span class="muted-text">缺少物流号或物流商</span>'}
    `;
  }
  if (/谷仓|goodcang/i.test(source)) {
    return '<span class="muted-text">谷仓系统预约面单</span>';
  }
  const placeholder = row.returnCreation?.returnTrackingProvided === false
    ? '可留空，后续再补'
    : '退货物流号';
  return `
    <div class="inline-form" data-order="${escapeHtml(row.rawOrderNo || '')}">
      <input
        class="inline-input"
        data-field="customerReturnTrackingNo"
        value="${escapeHtml(value || '')}"
        placeholder="${escapeHtml(placeholder)}"
      >
      <button class="button button--mini" type="button" data-action="save-tracking" ${value ? '' : 'disabled'}>保存</button>
      ${row.returnCreation?.returnTrackingProvided === false ? '<span class="inline-note">非必填，可后续补物流号</span>' : ''}
    </div>
  `;
}

function renderCandidateList(row) {
  const candidates = getCandidates(row);
  if (getReturnLogisticsMode(row) === 'custom' && !candidates.length) {
    const detail = [getCustomerReturnCarrierName(row), getCustomerReturnTrackingNo(row)].filter(Boolean).join(' / ');
    return `<span class="muted-text">${escapeHtml(detail || '自选物流')}</span>`;
  }
  if (row.returnCreation?.returnLabelRequired === false && !candidates.length) {
    return '<span class="muted-text">Return Label 否，无需试算</span>';
  }
  if (!candidates.length) return '<span class="muted-text">未返回报价</span>';

  const selected = getSelectedLogistics(row);
  const manualControls = canManualSelectLogistics(row)
    ? renderManualLogisticsPicker(row, candidates)
    : '';
  return `
    <div class="candidate-list">
      ${candidates.map(candidate => `
        <span class="candidate ${sameLogistics(candidate, selected) ? 'candidate--selected' : ''}">
          <span>${escapeHtml(candidate.name)}</span>
          <span class="money">${escapeHtml(formatMoney(candidate.price, candidate.currency))}</span>
        </span>
      `).join('')}
    </div>
    ${manualControls}
  `;
}

function renderManualLogisticsPicker(row, candidates = []) {
  const key = rowIdentity(row);
  const options = candidates.map((candidate, index) => {
    const code = candidate.code ? ` / ${candidate.code}` : '';
    const price = formatMoney(candidate.price, candidate.currency);
    return `<option value="${index}">${escapeHtml(`${candidate.name}${code} · ${price}`)}</option>`;
  }).join('');
  return `
    <div class="manual-logistics" data-row-key="${escapeHtml(key)}">
      <select class="select-input manual-logistics__select" data-field="manualLogistics">
        <option value="">手动选择物流商</option>
        ${options}
      </select>
      <button class="button button--mini manual-logistics__button" type="button" data-action="retry-logistics" disabled>用此物流重试</button>
    </div>
  `;
}

function renderSelectedLogistics(row) {
  if (row.returnCreation?.returnLabelRequired === false) {
    const carrierName = getCustomerReturnCarrierName(row);
    return `<span class="strong-text">Return Label 否</span><br><span class="muted-text">${escapeHtml(carrierName || '客户自寄')}</span>`;
  }
  const selected = getSelectedLogistics(row);
  if (!selected) return '<span class="muted-text">待试算</span>';
  return `
    <span class="strong-text">${escapeHtml(selected.name)}</span>
    <br><span class="money">${escapeHtml(formatMoney(selected.price, selected.currency))}</span>
  `;
}

function renderLabelDownload(row) {
  const download = getLabelDownload(row);
  if (!download) return '<span class="muted-text">未生成</span>';
  return `<a class="download-link" href="${escapeHtml(download.url)}" download>${escapeHtml(download.name || '下载面单')}</a>`;
}

function summarizeText(value, maxLength = 52) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function renderShortNote(note, noteClass) {
  const text = summarizeText(note || '无', 56);
  return `<span class="note-compact ${noteClass}" title="${escapeHtml(note || '无')}">${escapeHtml(text || '无')}</span>`;
}

function attemptedLogisticsNote(row = {}) {
  const attempts = asArray(row.returnCreation?.attemptedLogistics);
  if (!attempts.length) return '';
  return attempts
    .map(item => {
      const logistics = [item.name, item.code].filter(Boolean).join(' / ');
      const status = item.created ? '成功' : '失败';
      return `${logistics || '未知物流'}：${status}${item.message ? `，${item.message}` : ''}`;
    })
    .join('；');
}

function renderFlowPanel(rows) {
  if (!els.flowPanel) return;
  const current = rows.find(row => ['processing', 'running', 'matching', 'creating'].includes(String(row.status || '').toLowerCase())) || rows[0];
  if (!current) {
    els.flowPanel.innerHTML = '';
    return;
  }

  const steps = asArray(current.steps);
  els.flowPanel.innerHTML = `
    <div class="flow-card">
      <div class="flow-card__head">
        <strong>当前任务</strong>
        <span class="mono">${escapeHtml(current.rawOrderNo || current.stOrderNo || '')}</span>
      </div>
      <ol class="flow-list">
        ${steps.length ? steps.map(step => `
          <li class="flow-step">
            <span class="flow-step__time">${escapeHtml(formatBeijingTime(step.time).slice(12) || '--:--:--')}</span>
            <span class="flow-step__msg">${escapeHtml(step.message || step.name || '')}</span>
          </li>
        `).join('') : '<li class="flow-step"><span class="flow-step__msg">等待进展...</span></li>'}
      </ol>
    </div>
  `;
}

function renderSummary(rows) {
  if (!els.summaryGrid) return;

  if (!rows.length) {
    els.summaryGrid.innerHTML = '';
    return;
  }

  const preview = rows.filter(row => String(displayStatus(row) || '').toLowerCase() === 'dry-run').length;
  const created = rows.filter(row => ['created', 'success', 'succeeded'].includes(String(displayStatus(row) || '').toLowerCase())).length;
  const review = rows.filter(row => ['needs-review', 'review', 'skipped'].includes(String(displayStatus(row) || '').toLowerCase())).length;
  const failed = rows.filter(row => ['failed', 'error', 'cancelled'].includes(String(displayStatus(row) || '').toLowerCase())).length;

  els.summaryGrid.innerHTML = `
    <div class="stat-card"><span>总订单</span><strong>${rows.length}</strong></div>
    <div class="stat-card stat-card--ok"><span>已创建</span><strong>${created}</strong></div>
    <div class="stat-card"><span>预检完成</span><strong>${preview}</strong></div>
    <div class="stat-card stat-card--warn"><span>需复核</span><strong>${review}</strong></div>
    <div class="stat-card stat-card--danger"><span>失败</span><strong>${failed}</strong></div>
  `;
}

function renderRows() {
  const rows = getDisplayRows();
  renderSummary(rows);
  renderFlowPanel(rows);

  if (!els.resultsBody) return;

  if (!rows.length) {
    els.resultsBody.innerHTML = '<tr class="empty-row"><td colspan="11">等待输入订单。</td></tr>';
    return;
  }

  els.resultsBody.innerHTML = rows.map(row => {
    const error = firstValue(row.error, row.message, row.returnCreation?.message, getLastStepMessage(row));
    const quoteMessage = getQuoteMessage(row);
    const attemptMessage = attemptedLogisticsNote(row);
    const note = [attemptMessage, error, quoteMessage].filter(Boolean).join(' / ');
    const noteClass = row.status === 'failed' || row.status === 'error' || row.error ? 'error-text' : 'muted-text';
    return `
      <tr class="${rowClass(row.status)}">
        <td class="mono">${escapeHtml(row.rawOrderNo)}</td>
        <td>${statusTag(displayStatus(row))}</td>
        <td>${renderWarehouse(row)}</td>
        <td>${renderCustomerReturnTracking(row)}</td>
        <td>${renderCandidateList(row)}</td>
        <td class="mono">${escapeHtml(getTrackingNo(row) || '')}</td>
        <td>${renderSelectedLogistics(row)}</td>
        <td class="mono">${escapeHtml(getReturnOrderNo(row) || '')}</td>
        <td class="mono">${escapeHtml(getLabelNo(row) || '')}</td>
        <td>${renderLabelDownload(row)}</td>
        <td>${renderShortNote(note, noteClass)}</td>
      </tr>
    `;
  }).join('');
}

function renderHistoryLog(record) {
  const steps = asArray(record.steps).filter(step => step?.message);
  if (!steps.length) return '';
  return `
    <details class="history-log">
      <summary>操作日志</summary>
      <ol>
        ${steps.slice(-12).map(step => `
          <li>
            <span class="mono">${escapeHtml(step.timeBeijing || formatBeijingTime(step.time) || '--')}</span>
            <span>${escapeHtml(step.message)}</span>
          </li>
        `).join('')}
      </ol>
    </details>
  `;
}

function renderHistoryTime(value) {
  const text = formatBeijingTime(value) || String(value || '');
  const [date, time] = text.split(/\s+/);
  return `
    <span class="history-time">
      <span>${escapeHtml(date || '')}</span>
      ${time ? `<span>${escapeHtml(time)}</span>` : ''}
    </span>
  `;
}

function renderHistoryCode(value) {
  return `<span class="history-code">${escapeHtml(value || '')}</span>`;
}

function getHistorySelectedLogistics(record = {}) {
  return normalizeCandidate(firstValue(
    record.selectedLogistics,
    record.selectedLogisticsJson,
    record.responseJson?.returnCreation?.selectedLogistics,
    record.responseJson?.returnCreation?.shippingQuote?.selected,
    record.responseJson?.selectedLogistics
  )) || getSelectedLogistics(record.responseJson || {});
}

function renderHistoryLogistics(record = {}) {
  const selected = getHistorySelectedLogistics(record);
  if (!selected) return '<span class="muted-text">未返回</span>';
  const name = firstValue(selected.name, selected.code, '未命名渠道');
  const price = selected.price || selected.price === 0 ? ` ${formatMoney(selected.price, selected.currency)}` : '';
  const code = selected.code && selected.code !== selected.name ? `<br><span class="mono muted-text">${escapeHtml(selected.code)}</span>` : '';
  return `<span class="history-text">${escapeHtml(`${name}${price}`)}</span>${code}`;
}

function renderHistoryRows() {
  if (!els.historyBody) return;
  const rows = state.historyRecords;

  if (els.historyMeta) {
    const label = state.historyPlatform === 'all' ? '全部平台' : platformLabel(state.historyPlatform);
    els.historyMeta.textContent = `${label}，共 ${state.historyTotal} 条记录，显示 ${rows.length} 条。`;
  }

  if (!rows.length) {
    els.historyBody.innerHTML = '<tr class="empty-row"><td colspan="12">没有符合条件的历史记录。</td></tr>';
    return;
  }

  els.historyBody.innerHTML = rows.map(record => {
    const labelOrTracking = [record.labelNo, record.trackingNo].filter(Boolean).join(' / ');
    return `
      <tr class="${rowClass(record.displayStatus || record.status)}">
        <td>${renderHistoryTime(record.createdAtBeijing || record.createdAt)}</td>
        <td><span class="platform-badge platform-badge--${escapeHtml(record.platform || 'unknown')}">${escapeHtml(record.platformLabel || platformLabel(record.platform))}</span></td>
        <td class="mono">${renderHistoryCode(record.rawOrderNo)}</td>
        <td class="mono">${renderHistoryCode(record.stOrderNo)}</td>
        <td>${statusTag(record.displayStatus || record.status)}</td>
        <td class="mono">${renderHistoryCode(record.warehouseOrderNo)}</td>
        <td class="mono">${renderHistoryCode(record.returnOrderNo)}</td>
        <td class="mono">${renderHistoryCode(labelOrTracking)}</td>
        <td>${renderHistoryLogistics(record)}</td>
        <td>${record.labelDownloadUrl ? `<a class="download-link" href="${escapeHtml(record.labelDownloadUrl)}" download>下载面单</a>` : '<span class="muted-text">无</span>'}</td>
        <td class="history-note-cell">
          <span class="${record.displayStatus === 'failed' || record.status === 'failed' ? 'error-text' : 'muted-text'}">${escapeHtml(record.message || '无')}</span>
          ${renderHistoryLog(record)}
        </td>
        <td><button class="button button--mini button--danger" type="button" data-history-delete="${escapeHtml(record.id)}">删除</button></td>
      </tr>
    `;
  }).join('');
}

function renderQuoteMetaRow(label, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `
    <div class="quote-meta-row">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function quoteCandidatePool(quote = {}) {
  const pools = [
    quote.calculatorCandidates,
    quote.feeCandidates,
    quote.returnCandidates,
    quote.candidates,
    quote.officialReturnCandidates
  ];
  return (pools.find(items => Array.isArray(items) && items.length) || [])
    .map(normalizeCandidate)
    .filter(Boolean)
    .sort(compareCandidatesByPrice);
}

function getQuoteDisplaySelected(quote = {}) {
  const candidates = quoteCandidatePool(quote);
  return findCheapestCandidate(candidates) || normalizeCandidate(quote.selected);
}

function renderQuoteCandidateList(quote = {}) {
  const candidates = quoteCandidatePool(quote);
  if (!candidates.length) {
    return `<div class="quote-empty">${escapeHtml(quote.message || '未返回可用物流报价')}</div>`;
  }

  const selected = getQuoteDisplaySelected(quote);
  return `
    <div class="quote-candidate-list">
      ${candidates.map(candidate => `
        <div class="quote-candidate ${sameLogistics(candidate, selected) ? 'quote-candidate--selected' : ''}">
          <div class="quote-candidate__main">
            <span class="quote-candidate__name">${escapeHtml(candidate.name)}</span>
            ${candidate.code ? `<span class="quote-candidate__code">${escapeHtml(candidate.code)}</span>` : ''}
          </div>
          <span class="quote-candidate__price">${escapeHtml(formatMoney(candidate.price, candidate.currency))}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderQuotePlatformCard(item = {}) {
  const quote = item.quote || {};
  const warehouseOrder = item.warehouseOrder || {};
  const selected = getQuoteDisplaySelected(quote);
  const selectedText = selected ? `${selected.name} ${formatMoney(selected.price, selected.currency)}` : '';
  const triedWarehouseCodes = asArray(quote.triedWarehouseCodes).filter(Boolean).join(' / ');
  return `
    <section class="quote-card">
      <div class="quote-card__head">
        <span class="platform-badge platform-badge--${escapeHtml(item.platform || 'unknown')}">${escapeHtml(item.platformLabel || platformLabel(item.platform))}</span>
        ${selectedText ? `<span class="money">${escapeHtml(selectedText)}</span>` : ''}
      </div>
      <div class="quote-meta">
        ${renderQuoteMetaRow('仓库单', warehouseOrder.warehouseOrderNo || '未匹配')}
        ${renderQuoteMetaRow('仓库', firstValue(warehouseOrder.warehouseCode, warehouseOrder.warehouse))}
        ${renderQuoteMetaRow('资料来源', quote.dataSource)}
        ${renderQuoteMetaRow('试算仓库', quote.usedWarehouseCode)}
        ${renderQuoteMetaRow('试过仓库', triedWarehouseCodes)}
        ${renderQuoteMetaRow('试算邮编', quote.input?.address?.postcode)}
        ${renderQuoteMetaRow('跟踪号', firstValue(warehouseOrder.trackingNo, asArray(warehouseOrder.trackingNumbers)[0]))}
        ${renderQuoteMetaRow('状态', warehouseOrder.orderStatus)}
        ${renderQuoteMetaRow('说明', quote.message || warehouseOrder.message)}
      </div>
      ${renderQuoteCandidateList(quote)}
    </section>
  `;
}

function renderShippingQuoteResult(data = {}) {
  if (!els.quoteResult) return;
  const eccang = data.eccang || {};
  const products = asArray(eccang.products)
    .map(item => `${firstValue(item.warehouseSku, item.sku)} x${Number(item.quantity) || 1}`)
    .filter(Boolean)
    .join(' / ');
  const address = eccang.address || {};
  const addressText = [
    address.countryCode,
    address.state,
    address.city,
    address.postcode,
    address.address1,
    address.address2
  ].filter(Boolean).join(' ');
  const platformCards = asArray(data.quotes).map(renderQuotePlatformCard).join('');

  els.quoteResult.innerHTML = `
    <section class="quote-card">
      <div class="quote-card__head">
        <strong>易仓匹配</strong>
        <span class="mono muted-text">${escapeHtml(data.stOrderNo || '')}</span>
      </div>
      <div class="quote-meta">
        ${renderQuoteMetaRow('订单号', data.rawOrderNo)}
        ${renderQuoteMetaRow('仓库来源', platformLabel(data.inferredPlatform || eccang.platform))}
        ${renderQuoteMetaRow('易仓仓库', firstValue(eccang.warehouseCode, eccang.warehouse))}
        ${renderQuoteMetaRow('易仓单号', eccang.warehouseOrderNo)}
        ${renderQuoteMetaRow('跟踪号', eccang.trackingNo)}
        ${renderQuoteMetaRow('SKU', products)}
        ${renderQuoteMetaRow('地址', addressText)}
        ${renderQuoteMetaRow('补充邮编', data.addressSupplement?.postcode)}
      </div>
    </section>
    ${platformCards || '<div class="quote-empty">没有返回试算结果。</div>'}
  `;
}

function setQuoteStatus(message, isError = false) {
  if (!els.quoteStatus) return;
  els.quoteStatus.textContent = message;
  els.quoteStatus.classList.toggle('quote-status--error', isError);
}

function setQuoteRunning(running) {
  if (els.quoteRunBtn) els.quoteRunBtn.disabled = running;
  if (els.quoteStopBtn) els.quoteStopBtn.disabled = !running;
  if (els.quoteOrderInput) els.quoteOrderInput.disabled = running;
  if (els.quotePlatformSelect) els.quotePlatformSelect.disabled = running;
  if (els.quotePostcodeInput) els.quotePostcodeInput.disabled = running;
}

function stopShippingQuote() {
  if (!state.quoteAbortController) return;
  state.quoteAbortController.abort();
  state.quoteAbortController = null;
  state.quoteRunId += 1;
  setQuoteRunning(false);
  setQuoteStatus('已停止本次试算。');
}

function setQuoteDrawerOpen(open) {
  els.quoteDrawer?.classList.toggle('is-open', open);
  els.quoteDrawer?.setAttribute('aria-hidden', open ? 'false' : 'true');
  els.quoteOverlay?.classList.toggle('is-hidden', !open);
  els.quoteOverlay?.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open && els.quoteOrderInput && !els.quoteOrderInput.value.trim()) {
    const firstOrder = getInputOrders()[0]?.rawOrderNo || '';
    if (firstOrder) els.quoteOrderInput.value = firstOrder;
  }
  if (open) setTimeout(() => els.quoteOrderInput?.focus(), 80);
}

async function runShippingQuote() {
  if (state.quoteAbortController) state.quoteAbortController.abort();
  const orderNo = String(els.quoteOrderInput?.value || '').trim();
  const platform = String(els.quotePlatformSelect?.value || 'auto').trim();
  const postcode = String(els.quotePostcodeInput?.value || '').trim();
  if (!orderNo) {
    setQuoteStatus('请输入易仓完整订单号。', true);
    return;
  }

  const controller = new AbortController();
  const runId = state.quoteRunId + 1;
  state.quoteRunId = runId;
  state.quoteAbortController = controller;
  setQuoteRunning(true);
  setQuoteStatus(platform === 'auto'
    ? '正在匹配易仓仓库来源并试算...'
    : `正在调用${platformLabel(platform)}费用计算器...`);
  if (els.quoteResult) els.quoteResult.innerHTML = '<div class="quote-empty">试算中...</div>';

  try {
    const res = await fetch('/api/shipping-quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNo, platform, postcode }),
      signal: controller.signal
    });
    if (runId !== state.quoteRunId) return;
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(json, '运费试算失败'));
    const payload = getPayload(json);
    renderShippingQuoteResult(payload);
    const quote = asArray(payload.quotes)[0]?.quote || {};
    const count = quoteCandidatePool(quote).length;
    setQuoteStatus(`试算完成：${platformLabel(asArray(payload.quotes)[0]?.platform || payload.inferredPlatform)}，返回 ${count} 个候选物流。`);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (runId !== state.quoteRunId) return;
    if (els.quoteResult) els.quoteResult.innerHTML = '';
    setQuoteStatus(error.message, true);
  } finally {
    if (runId === state.quoteRunId) {
      state.quoteAbortController = null;
      setQuoteRunning(false);
    }
  }
}

async function loadHistory({ silent = false } = {}) {
  if (!silent) {
    if (els.historyRefreshBtn) els.historyRefreshBtn.disabled = true;
    if (els.historyBody) els.historyBody.innerHTML = '<tr class="empty-row"><td colspan="12">历史记录加载中。</td></tr>';
  }

  const params = new URLSearchParams({
    platform: state.historyPlatform,
    keyword: state.historyKeyword,
    limit: '200'
  });

  try {
    const res = await fetch(`/api/history?${params.toString()}`);
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(json, '历史记录查询失败'));
    const payload = getPayload(json);
    state.historyRecords = asArray(payload?.items || payload?.records || payload);
    state.historyTotal = Number(payload?.total ?? state.historyRecords.length) || state.historyRecords.length;
    renderHistoryRows();
  } catch (error) {
    if (els.historyBody) {
      els.historyBody.innerHTML = `<tr class="empty-row"><td colspan="12">${escapeHtml(error.message)}</td></tr>`;
    }
  } finally {
    if (els.historyRefreshBtn) els.historyRefreshBtn.disabled = false;
  }
}

function switchView(view) {
  state.activeView = view === 'history' ? 'history' : 'create';
  els.createView?.classList.toggle('is-hidden', state.activeView !== 'create');
  els.historyView?.classList.toggle('is-hidden', state.activeView !== 'history');
  els.viewTabs.forEach(button => {
    button.classList.toggle('tab-button--active', button.dataset.viewTab === state.activeView);
  });
  if (state.activeView === 'history') loadHistory();
}

function setHistoryPlatform(platform) {
  state.historyPlatform = platform || 'all';
  els.historyPlatformBtns.forEach(button => {
    button.classList.toggle('segmented__button--active', button.dataset.historyPlatform === state.historyPlatform);
  });
  loadHistory();
}

let historySearchTimer = null;

function scheduleHistorySearch(value) {
  state.historyKeyword = String(value || '').trim();
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(), 250);
}

async function deleteHistoryRecord(id) {
  if (!id) return;
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const json = await readJson(res);
  if (!res.ok) {
    if (els.historyMeta) els.historyMeta.textContent = errorMessage(json, '删除历史记录失败');
    return;
  }
  state.historyRecords = state.historyRecords.filter(record => record.id !== id);
  state.historyTotal = Math.max(0, state.historyTotal - 1);
  renderHistoryRows();
}

function setStatus(message, isError = false) {
  if (!els.statusbar) return;
  els.statusbar.textContent = message;
  els.statusbar.classList.toggle('statusbar--error', isError);
}

function updateInputMeta() {
  const orders = getInputOrders();
  const count = orders.length;
  const customCount = orders.filter(order => order.returnLogisticsMode === 'custom').length;
  const suffix = customCount ? `，${customCount} 个自选物流` : '';
  if (els.inputCount) els.inputCount.textContent = `${count} 个订单待${els.dryRun?.checked ? '预检' : '创建'}${suffix}`;
}

function updateRiskNotice() {
  const count = getInputOrders().length;
  const isDryRun = Boolean(els.dryRun?.checked);

  if (isDryRun && els.allowCreate?.checked) els.allowCreate.checked = false;
  if (els.allowCreate) els.allowCreate.disabled = isDryRun;

  els.riskNotice?.classList.remove('risk-panel--armed', 'risk-panel--blocked');
  els.modePill?.classList.remove('mode-pill--live');

  if (isDryRun) {
    if (els.modePill) els.modePill.textContent = 'Dry-run';
    if (els.runBtn) els.runBtn.textContent = '开始预检';
    if (els.riskNotice) {
      els.riskNotice.innerHTML = '<strong>当前为预检模式</strong><span>单列订单走平台自动物流；三列“订单号 物流号 物流商”走自选物流。万邑通物流号是软字段，可留空。</span>';
    }
    return;
  }

  if (els.modePill) {
    els.modePill.textContent = '真实创建';
    els.modePill.classList.add('mode-pill--live');
  }
  if (els.runBtn) els.runBtn.textContent = '创建退货面单';

  if (!els.allowCreate?.checked) {
    els.riskNotice?.classList.add('risk-panel--blocked');
    if (els.riskNotice) {
      els.riskNotice.innerHTML = '<strong>真实创建未授权</strong><span>必须勾选允许真实创建后才会提交创建请求。</span>';
    }
    return;
  }

  if (count > state.realCreateMaxPerJob) {
    els.riskNotice?.classList.add('risk-panel--blocked');
    if (els.riskNotice) {
      els.riskNotice.innerHTML = `<strong>真实创建被前端拦截</strong><span>真实创建每批最多 ${state.realCreateMaxPerJob} 单；当前输入 ${count} 单。</span>`;
    }
    return;
  }

  els.riskNotice?.classList.add('risk-panel--armed');
  if (els.riskNotice) {
    const crawlerNote = state.preferCrawlerOnly
      ? '当前为 API 模式；旧爬虫兜底开关仍开启，请后端确认。'
      : '谷仓继续走 API；万邑通会按当前页面策略创建。';
    els.riskNotice.innerHTML = `<strong>真实创建已解锁</strong><span>本批最多提交 ${state.realCreateMaxPerJob} 单，并发 ${state.orderConcurrency} 单；单列走平台自动物流，三列走自选物流。${crawlerNote}</span>`;
  }
}

function updateUiFromInput() {
  updateWinitOptionsUi();
  updateInputMeta();
  updateRiskNotice();
  if (!state.job && !state.results.length) renderRows();
}

function saveInlineTracking(rawOrderNo, trackingNo) {
  const target = String(rawOrderNo || '').trim();
  if (!target || !els.ordersInput) return;
  const next = getInputOrders().map(order => {
    if (order.rawOrderNo !== target) return order;
    return {
      ...order,
      customerReturnTrackingNo: String(trackingNo || '').trim(),
      returnExpressNo: String(trackingNo || '').trim()
    };
  });
  els.ordersInput.value = next.map(composeOrderLine).join('\n');
  state.job = null;
  state.results = [];
  updateUiFromInput();
  setStatus(`已保存 ${target} 的客户退货跟踪号。`);
}

function closeJobStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function connectJobStream(id) {
  if (!id || typeof EventSource === 'undefined') return;
  closeJobStream();

  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  source.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.job) applyJob(payload.job);
      if (payload?.event && payload.job?.status) {
        const [statusLabel] = statusMeta(payload.job.status);
        setStatus(`任务 ${payload.job.id}: ${statusLabel}`);
      }
    } catch {}
  };
  source.onerror = () => {
    if (state.eventSource === source) {
      source.close();
      state.eventSource = null;
    }
  };
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function applyJob(jobLike) {
  const job = normalizeJob(getJobPayload(jobLike));
  state.job = job;
  if (state.retryMergeJobId && job.id === state.retryMergeJobId) {
    state.results = mergeDisplayRows(state.results.length ? state.results : getDisplayRows(), job.results);
  } else {
    state.results = job.results.length ? job.results : state.results;
  }
  renderRows();
  return job;
}

async function fetchJob(id) {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
  const json = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(json, '任务查询失败'));
  return getJobPayload(json);
}

function schedulePoll(id) {
  stopPolling();

  state.pollTimer = setTimeout(async () => {
    try {
      const job = applyJob(await fetchJob(id));
      const [statusLabel] = statusMeta(job.status);
      setStatus(`任务 ${id}: ${statusLabel}`);

      if (!isTerminalStatus(job.status)) {
        schedulePoll(id);
      } else {
        stopPolling();
        closeJobStream();
        if (state.retryMergeJobId === job.id) state.retryMergeJobId = null;
        loadHistory({ silent: true });
      }
    } catch (error) {
      const elapsed = Date.now() - state.pollStartedAt;
      if (elapsed < 5 * 60 * 1000) {
        setStatus(`轮询暂时失败，将继续重试：${error.message}`, true);
        schedulePoll(id);
      } else {
        stopPolling();
        closeJobStream();
        setStatus(`轮询失败：${error.message}`, true);
      }
    }
  }, POLL_INTERVAL_MS);
}

async function createJob() {
  state.retryMergeJobId = null;
  const orders = getInputOrders();
  const liveCreate = !els.dryRun?.checked;

  if (!orders.length) {
    setStatus('请输入至少 1 个原始 PO 订单号。', true);
    renderRows();
    return;
  }

  if (liveCreate && !els.allowCreate?.checked) {
    setStatus('真实创建前需要勾选“允许真实创建”。', true);
    updateRiskNotice();
    return;
  }

  if (liveCreate && orders.length > state.realCreateMaxPerJob) {
    setStatus(`真实创建每批最多 ${state.realCreateMaxPerJob} 单；请缩小批次后再执行。`, true);
    updateRiskNotice();
    return;
  }

  stopPolling();
  closeJobStream();
  state.job = null;
  state.results = orders.map(order => ({ ...order, status: 'queued' }));
  renderRows();

  if (els.runBtn) els.runBtn.disabled = true;
  setStatus(liveCreate ? '正在提交真实创建任务...' : '正在提交 dry-run 预检任务...');

  try {
    const payload = {
      input: els.ordersInput?.value || '',
      orders,
      dryRun: Boolean(els.dryRun?.checked),
      allowCreate: Boolean(els.allowCreate?.checked),
      concurrency: state.orderConcurrency,
      winitOptions: collectWinitOptions(),
      ...storedOperatorPayload()
    };
    if (payload.dryRun) payload.preflight = true;

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(json, '创建任务失败'));

    const job = applyJob(json);
    if (!job.id) throw new Error('后端未返回任务 ID，无法轮询任务状态。');

    const [statusLabel] = statusMeta(job.status);
    setStatus(`任务 ${job.id}: ${statusLabel}，开始轮询结果。`);
    state.pollStartedAt = Date.now();
    connectJobStream(job.id);

    if (!isTerminalStatus(job.status)) {
      schedulePoll(job.id);
    } else {
      loadHistory({ silent: true });
    }
  } catch (error) {
    setStatus(error.message, true);
    renderRows();
  } finally {
    if (els.runBtn) els.runBtn.disabled = false;
  }
}

async function retryWithSelectedLogistics(form) {
  const row = findDisplayRowByKey(form?.dataset?.rowKey || '');
  const select = form?.querySelector('[data-field="manualLogistics"]');
  const index = Number(select?.value);
  const candidates = row ? getCandidates(row) : [];
  const candidate = Number.isInteger(index) ? candidates[index] : null;
  const preferred = firstValue(candidate?.code, candidate?.name, '');
  if (!row || !candidate || !preferred) {
    setStatus('请先选择一个可用物流商。', true);
    return;
  }

  const liveCreate = !els.dryRun?.checked;
  if (liveCreate && !els.allowCreate?.checked) {
    setStatus('真实创建前需要勾选“允许真实创建”。', true);
    updateRiskNotice();
    return;
  }

  stopPolling();
  closeJobStream();
  const retryRow = {
    ...row,
    status: 'queued',
    displayStatus: 'queued',
    preferredReturnCourier: preferred,
    manualRetryLogistics: candidate,
    error: '',
    message: `已选择 ${candidate.name || preferred}，等待重试。`
  };
  state.results = mergeDisplayRows(getDisplayRows(), [retryRow]);
  renderRows();
  setStatus(`正在用 ${candidate.name || preferred} 重试 ${row.rawOrderNo || row.stOrderNo}...`);

  try {
    const payload = {
      orders: [{
        rawOrderNo: row.rawOrderNo || row.stOrderNo,
        stOrderNo: row.stOrderNo || normalizeStOrder(row.rawOrderNo),
        returnLogisticsMode: 'auto',
        preferredReturnCourier: preferred,
        manualSelectedLogistics: candidate
      }],
      dryRun: Boolean(els.dryRun?.checked),
      allowCreate: Boolean(els.allowCreate?.checked),
      concurrency: 1,
      winitOptions: collectWinitOptions(),
      ...storedOperatorPayload()
    };
    if (payload.dryRun) payload.preflight = true;

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(json, '物流重试任务创建失败'));

    const job = normalizeJob(getJobPayload(json));
    if (!job.id) throw new Error('后端未返回任务 ID，无法轮询重试结果。');
    state.retryMergeJobId = job.id;
    applyJob(job);
    state.pollStartedAt = Date.now();
    connectJobStream(job.id);
    if (!isTerminalStatus(job.status)) {
      schedulePoll(job.id);
    } else {
      state.retryMergeJobId = null;
      loadHistory({ silent: true });
    }
  } catch (error) {
    state.results = mergeDisplayRows(getDisplayRows(), [{ ...row, status: 'needs-review', error: error.message }]);
    setStatus(error.message, true);
    renderRows();
  }
}

async function probeLogins() {
  if (els.probeBtn) els.probeBtn.disabled = true;
  setStatus('正在检查平台 API 状态...');

  try {
    const res = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(json, '检查失败'));

    const payload = getPayload(json);
    const items = Array.isArray(payload) ? payload : asArray(payload?.items || payload?.platforms || payload?.results);
    if (!items.length) {
      setStatus('登录检查完成，但后端未返回平台明细。');
      return;
    }

    setStatus(items.map(item => {
      const platform = firstValue(item.platform, item.name, item.key, '未知平台');
      const ok = Boolean(firstValue(item.login?.ok, item.ok, item.loggedIn, item.isLoggedIn));
      const message = firstValue(item.error, item.message, item.login?.message, '');
      return `${platform}: ${ok ? 'API 可用' : `需处理${message ? ` (${message})` : ''}`}`;
    }).join('；'));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (els.probeBtn) els.probeBtn.disabled = false;
  }
}

function rowToCsv(row) {
  const candidates = getCandidates(row)
    .map(candidate => `${candidate.name} ${formatMoney(candidate.price, candidate.currency)}`)
    .join(' | ');
  const selected = getSelectedLogistics(row);
  const error = firstValue(row.error, row.message, row.returnCreation?.message, getLastStepMessage(row));
  const quoteMessage = getQuoteMessage(row);
  const matched = getWarehouseOrderNo(row) || row.eccang?.matched === true;
  const download = getLabelDownload(row);

  return [
    row.rawOrderNo,
    row.stOrderNo || normalizeStOrder(row.rawOrderNo),
    statusMeta(displayStatus(row))[0],
    matched ? '已匹配' : '待匹配',
    getWarehouseSource(row),
    getReturnLogisticsMode(row) === 'custom' ? '自选物流' : '平台自动物流',
    getCustomerReturnTrackingNo(row),
    getCustomerReturnCarrierName(row),
    candidates,
    selected ? `${selected.name} ${formatMoney(selected.price, selected.currency)}` : '',
    getTrackingNo(row),
    getReturnOrderNo(row),
    getLabelNo(row),
    download?.url || '',
    [error, quoteMessage].filter(Boolean).join(' / ')
  ];
}

function exportCsv() {
  const rows = getDisplayRows();
  if (!rows.length) {
    setStatus('没有可导出的结果。', true);
    return;
  }

  const headers = ['原始订单', 'ST订单', '状态', '易仓匹配', '仓库来源', '退货物流模式', '退货物流号', '退货物流商', '候选物流费用', '最低价渠道', '跟踪号', '退货单号', '面单号', '面单下载', '错误/备注'];
  const csv = [headers, ...rows.map(rowToCsv)]
    .map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `return-label-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`已导出 ${rows.length} 行 CSV。`);
}

function handleResultsInput(event) {
  const input = event.target?.closest?.('[data-field="customerReturnTrackingNo"]');
  const select = event.target?.closest?.('[data-field="manualLogistics"]');
  if (select) {
    const form = select.closest('.manual-logistics');
    const button = form?.querySelector('[data-action="retry-logistics"]');
    if (button) button.disabled = !select.value;
    return;
  }
  if (!input) return;
  const form = input.closest('.inline-form');
  const button = form?.querySelector('[data-action="save-tracking"]');
  if (button) button.disabled = !input.value.trim();
}

function handleResultsClick(event) {
  const retryButton = event.target?.closest?.('[data-action="retry-logistics"]');
  if (retryButton) {
    retryWithSelectedLogistics(retryButton.closest('.manual-logistics'));
    return;
  }
  const button = event.target?.closest?.('[data-action="save-tracking"]');
  if (!button) return;
  const form = button.closest('.inline-form');
  const rawOrderNo = form?.dataset?.order || '';
  const input = form?.querySelector('[data-field="customerReturnTrackingNo"]');
  saveInlineTracking(rawOrderNo, input?.value || '');
}

els.runBtn?.addEventListener('click', createJob);
els.probeBtn?.addEventListener('click', probeLogins);
els.exportBtn?.addEventListener('click', exportCsv);
els.quoteDrawerToggle?.addEventListener('click', () => setQuoteDrawerOpen(true));
els.quoteDrawerClose?.addEventListener('click', () => setQuoteDrawerOpen(false));
els.quoteOverlay?.addEventListener('click', () => setQuoteDrawerOpen(false));
els.quoteRunBtn?.addEventListener('click', runShippingQuote);
els.quoteStopBtn?.addEventListener('click', stopShippingQuote);
els.quoteOrderInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') runShippingQuote();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setQuoteDrawerOpen(false);
});
els.resultsBody?.addEventListener('input', handleResultsInput);
els.resultsBody?.addEventListener('change', handleResultsInput);
els.resultsBody?.addEventListener('click', handleResultsClick);
els.ordersInput?.addEventListener('input', updateUiFromInput);
els.dryRun?.addEventListener('change', updateUiFromInput);
els.allowCreate?.addEventListener('change', updateUiFromInput);
els.viewTabs.forEach(button => {
  button.addEventListener('click', () => switchView(button.dataset.viewTab));
});
els.historyRefreshBtn?.addEventListener('click', () => loadHistory());
els.historySearch?.addEventListener('input', event => scheduleHistorySearch(event.target.value));
els.historyPlatformBtns.forEach(button => {
  button.addEventListener('click', () => setHistoryPlatform(button.dataset.historyPlatform));
});
els.winitStockStrategies.forEach(input => {
  input.addEventListener('change', updateUiFromInput);
});
els.winitTemplateType?.addEventListener('change', updateUiFromInput);
els.historyBody?.addEventListener('click', event => {
  const button = event.target?.closest?.('[data-history-delete]');
  if (!button) return;
  deleteHistoryRecord(button.dataset.historyDelete);
});

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const json = await readJson(res);
    if (res.ok && Number.isFinite(Number(json.realCreateMaxPerJob))) {
      state.realCreateMaxPerJob = Math.max(1, Number(json.realCreateMaxPerJob));
    }
    if (res.ok && Number.isFinite(Number(json.orderConcurrency))) {
      state.orderConcurrency = Math.max(1, Number(json.orderConcurrency));
    }
    if (res.ok && json.preferCrawlerOnly !== undefined) {
      state.preferCrawlerOnly = Boolean(json.preferCrawlerOnly);
    }
  } catch {}
  updateUiFromInput();
}

hydrateOperatorFromQuery();
loadHealth();
