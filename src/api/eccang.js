const crypto = require('crypto');
const { config } = require('../env');
const { normalizeOrderNo } = require('../order-normalizer');
const {
  apiMessage,
  apiSuccess,
  asArray,
  collectObjects,
  compactText,
  extractTrackingNumbers,
  fetchJson,
  firstNonEmpty,
  includesQuery,
  md5,
  safeSnippet
} = require('./common');

const ORDER_LIST_CONDITION_KEYS = [
  'reference_no_list',
  'order_code_list',
  'warehouse_order_code_list'
];

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function requireConfig() {
  const missing = [];
  if (!config.api.eccang.appKey) missing.push('ECCANG_APP_KEY');
  if (!config.api.eccang.appSecret) missing.push('ECCANG_APP_SECRET');
  if (missing.length) {
    throw new Error(`易仓 API 缺少配置：${missing.join(', ')}`);
  }
}

function buildBizContent(content) {
  return typeof content === 'string' ? content : JSON.stringify(content || {});
}

function signParams(params, secret, uppercase = true) {
  const raw = Object.keys(params)
    .filter(key => key !== 'sign' && params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&') + secret;
  const signed = md5(raw);
  return uppercase ? signed.toUpperCase() : signed;
}

async function eccangCall(interfaceMethod, bizContent = {}) {
  requireConfig();
  const params = {
    app_key: config.api.eccang.appKey,
    charset: config.api.eccang.charset || 'UTF-8',
    interface_method: interfaceMethod,
    version: 'V1.0.0',
    timestamp: Date.now(),
    nonce_str: crypto.randomBytes(8).toString('hex'),
    sign_type: 'MD5',
    biz_content: buildBizContent(bizContent)
  };
  if (config.api.eccang.serviceId) {
    params.service_id = config.api.eccang.serviceId;
  }
  params.sign = signParams(params, config.api.eccang.appSecret, config.api.eccang.signUppercase);

  const response = await fetchJson(config.api.eccang.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    timeoutMs: 30000
  });
  return {
    interfaceMethod,
    requestBizContent: bizContent,
    ok: response.ok,
    status: response.status,
    json: response.json,
    text: response.text,
    error: response.error
  };
}

function responsePayload(json) {
  if (!json || typeof json !== 'object') return json;
  if (json.biz_content) return parseMaybeJson(json.biz_content);
  return parseMaybeJson(json.data) ?? parseMaybeJson(json.result) ?? json.rows ?? json.list ?? json;
}

function flattenData(value) {
  const payload = responsePayload(value);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return payload && typeof payload === 'object' ? [payload] : [];
}

function firstDeepValue(value, names) {
  const normalized = names.map(name => String(name).toLowerCase());
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [key, item] of Object.entries(current)) {
      if (normalized.includes(String(key).toLowerCase()) && item !== undefined && item !== null && String(item) !== '') {
        return item;
      }
    }
    for (const item of Object.values(current)) {
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  return '';
}

function deepValues(value, names, limit = 12) {
  const normalized = names.map(name => String(name).toLowerCase());
  const queue = [value];
  const seen = new Set();
  const output = [];
  const addValue = item => {
    if (item === undefined || item === null || String(item) === '') return;
    const text = String(item);
    if (!output.includes(text)) output.push(text);
  };

  while (queue.length && output.length < limit) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [key, item] of Object.entries(current)) {
      if (normalized.includes(String(key).toLowerCase())) {
        if (Array.isArray(item)) {
          for (const entry of item) addValue(entry);
        } else {
          addValue(item);
        }
      }
    }
    for (const item of Object.values(current)) {
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  return output;
}

function unique(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && String(value) !== '').map(String))];
}

function textContainsOrder(value, stOrderNo) {
  const withoutPrefix = String(stOrderNo || '').replace(/^ST-/i, '');
  const raw = String(stOrderNo || '').replace(/^ST-/i, '').replace(/-D\d{2}$/i, '');
  const text = compactText(JSON.stringify(value || {}));
  return includesQuery(text, stOrderNo) ||
    includesQuery(text, withoutPrefix) ||
    includesQuery(text, raw);
}

function normalizeProducts(value) {
  const objects = collectObjects(value, item =>
    Boolean(
      item.sku ||
      item.product_sku ||
      item.productSku ||
      item.platform_sku ||
      item.platformSku ||
      item.product_sku_list ||
      item.productSkuList ||
      item.warehouse_sku ||
      item.warehouseSku ||
      item.product_code ||
      item.productCode
    )
  );
  const products = objects.map(item => {
    const sku = firstNonEmpty(
      item.product_sku,
      item.productSku,
      item.sku,
      item.platform_sku,
      item.platformSku,
      item.product_sku_list,
      item.productSkuList,
      item.product_code,
      item.productCode,
      item.itemSku
    );
    const warehouseSku = firstNonEmpty(
      item.warehouse_sku,
      item.warehouseSku,
      item.product_barcode,
      item.productBarcode,
      item.gcSku,
      item.winitProductCode,
      sku
    );
    const quantity = Number(firstNonEmpty(
      item.quantity,
      item.qty,
      item.num,
      item.warehouse_sku_qty,
      item.warehouseSkuQty,
      item.product_num,
      item.productNum,
      item.op_quantity,
      item.ob_qty,
      1
    )) || 1;
    return { sku, warehouseSku, quantity };
  }).filter(item => item.sku || item.warehouseSku);
  const bySku = new Map();
  for (const item of products) {
    const key = firstNonEmpty(item.warehouseSku, item.sku);
    const existing = bySku.get(key);
    if (!existing) {
      bySku.set(key, item);
      continue;
    }
    bySku.set(key, {
      sku: firstNonEmpty(existing.sku, item.sku),
      warehouseSku: firstNonEmpty(existing.warehouseSku, item.warehouseSku),
      quantity: Math.max(Number(existing.quantity) || 1, Number(item.quantity) || 1)
    });
  }
  return [...bySku.values()];
}

function normalizeAddress(value) {
  const candidate = collectObjects(value, item =>
    Boolean(
      item.country_code ||
      item.countryCode ||
      item.country ||
      item.consignee_country_code ||
      item.receiver_country_code ||
      item.address1 ||
      item.street1 ||
      item.line1 ||
      item.oab_firstname ||
      item.zipcode ||
      item.postcode ||
      item.postal_code ||
      item.phone ||
      item.consignee_name ||
      item.oab_phone ||
      item.oab_email
    )
  )[0] || {};
  const nestedCountry = candidate.country && typeof candidate.country === 'object' ? candidate.country : {};
  return {
    name: firstNonEmpty(candidate.name, candidate.consignee_name, candidate.receiverName, candidate.buyerName, candidate.oab_firstname),
    lastName: firstNonEmpty(candidate.last_name, candidate.lastName, candidate.oab_lastname),
    phone: firstNonEmpty(candidate.phone, candidate.tel, candidate.mobile, candidate.consignee_phone, candidate.oab_phone, candidate.oab_cell_phone),
    email: firstNonEmpty(candidate.email, candidate.buyerEmail, candidate.oab_email),
    countryCode: firstNonEmpty(
      candidate.country_code,
      candidate.countryCode,
      candidate.consignee_country_code,
      candidate.receiver_country_code,
      nestedCountry.country_code,
      typeof candidate.country === 'string' ? candidate.country : ''
    ),
    countryText: firstNonEmpty(candidate.country_name, candidate.countryName, nestedCountry.country_name_en, nestedCountry.country_name, typeof candidate.country === 'string' ? candidate.country : ''),
    state: firstNonEmpty(candidate.state, candidate.province, candidate.consignee_state, candidate.receiverState, candidate.oab_state),
    city: firstNonEmpty(candidate.city, candidate.city_name, candidate.consignee_city, candidate.receiverCity, candidate.oab_city),
    postcode: firstNonEmpty(
      candidate.postcode,
      candidate.zipcode,
      candidate.zip_code,
      candidate.postal_code,
      candidate.consignee_zipcode,
      candidate.oab_postcode
    ),
    address1: firstNonEmpty(
      candidate.address1,
      candidate.street1,
      candidate.line1,
      candidate.address,
      candidate.consignee_address1,
      candidate.oab_street_address1
    ),
    address2: firstNonEmpty(
      candidate.address2,
      candidate.street2,
      candidate.line2,
      candidate.line3,
      candidate.consignee_address2,
      candidate.oab_street_address2
    ),
    company: firstNonEmpty(candidate.company, candidate.companyName, candidate.company_name, candidate.oab_company),
    rawTextSnippet: safeSnippet(candidate, 1200)
  };
}

function parseEccangPayload(payload, stOrderNo, source = '', options = {}) {
  const normalizedPayload = responsePayload(payload);
  const objects = flattenData(normalizedPayload);
  const matching = objects.filter(item => textContainsOrder(item, stOrderNo));
  const isSingleDetail = objects.length === 1 && !Array.isArray(normalizedPayload?.data) && !Array.isArray(normalizedPayload?.list);
  const trustedSingleRecord = Boolean(options.trustSingleRecord && objects.length === 1);
  const target = matching[0] || (isSingleDetail || trustedSingleRecord ? objects[0] : null);
  const rawText = compactText(JSON.stringify(target || normalizedPayload || payload || {}));
  const matchedTarget = Boolean(target && (textContainsOrder(target, stOrderNo) || isSingleDetail || trustedSingleRecord));
  if (!matchedTarget) {
    return {
      stOrderNo,
      found: false,
      matched: false,
      source,
      trackingNo: '',
      trackingNumbers: [],
      warehouse: '',
      warehouseCode: '',
      platform: '',
      warehouseOrderNo: '',
      warehouseOrderCandidates: [],
      products: [],
      primarySku: '',
      quantity: 1,
      address: {},
      rawTextSnippet: rawText.slice(0, 4000)
    };
  }
  const trackingNumbers = [
    firstDeepValue(target, [
      'tracking_no',
      'trackingNo',
      'tracking_number',
      'trackingNumber',
      'shipping_method_no',
      'shippingMethodNo',
      'shipping_tracking_no',
      'trackNo',
      'express_no',
      'outbound_batch_tracking_no',
      'outboundBatchTrackingNo'
    ]),
    ...extractTrackingNumbers(rawText)
  ].filter(Boolean);
  const warehouse = firstDeepValue(target, [
    'warehouse_name',
    'warehouseName',
    'warehouse',
    'shipping_warehouse_name',
    'shipWarehouseName'
  ]);
  const warehouseCode = firstDeepValue(target, [
    'warehouse_code',
    'warehouseCode',
    'warehouse_id',
    'warehouseId',
    'ship_warehouse_code',
    'shipWarehouseCode',
    'warehouse_code_text'
  ]);
  const platformHint = compactText([
    warehouse,
    warehouseCode,
    firstDeepValue(target, ['carrier', 'carrierName', 'platform', 'provider'])
  ].join(' '));
  const platform =
    /winit|万邑/i.test(platformHint) ? 'winit' :
    /goodcang|谷仓/i.test(platformHint) ? 'goodcang' :
    '';
  const warehouseOrderNo = firstDeepValue(target, [
    'warehouse_order_code',
    'warehouseOrderCode',
    'warehouse_order_no',
    'warehouseOrderNo',
    'warehosue_order_code',
    'so_code',
    'soCode',
    'wms_order_no',
    'wmsOrderNo'
  ]);
  const orderCode = firstDeepValue(target, [
    'order_code',
    'orderCode',
    'sales_order_code',
    'salesOrderCode'
  ]);
  const referenceNo = firstDeepValue(target, [
    'refrence_no',
    'reference_no',
    'referenceNo',
    'ref_no',
    'refNo'
  ]);
  const products = normalizeProducts(target);
  const address = normalizeAddress(target);
  const warehouseOrderCandidates = unique([
    warehouseOrderNo,
    ...deepValues(target, [
      'warehouse_order_code',
      'warehouseOrderCode',
      'warehouse_order_no',
      'warehouseOrderNo',
      'warehosue_order_code',
      'wms_order_no',
      'wmsOrderNo'
    ])
  ]);
  const orderCodeCandidates = unique([
    orderCode,
    ...deepValues(target, ['order_code', 'orderCode', 'sales_order_code', 'salesOrderCode'])
  ]);
  return {
    stOrderNo,
    found: Boolean(rawText && matchedTarget && (trackingNumbers.length || warehouseOrderNo || textContainsOrder(target, stOrderNo))),
    matched: Boolean(rawText && matchedTarget && (trackingNumbers.length || warehouseOrderNo || textContainsOrder(target, stOrderNo))),
    source,
    trackingNo: trackingNumbers[0] || '',
    trackingNumbers: [...new Set(trackingNumbers)],
    warehouse: warehouse || warehouseCode || '',
    warehouseCode,
    platform,
    warehouseOrderNo,
    warehouseOrderCandidates,
    orderCode,
    orderCodeCandidates,
    referenceNo,
    products,
    primarySku: products[0]?.warehouseSku || products[0]?.sku || '',
    quantity: products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1,
    address,
    rawTextSnippet: rawText.slice(0, 4000)
  };
}

function orderListBiz(condition) {
  return {
    page: 1,
    page_size: 20,
    get_detail: 1,
    get_address: 1,
    get_custom_order_type: 1,
    condition
  };
}

function stpoBiz(key, value) {
  return {
    page: 1,
    pageSize: 20,
    page_size: 20,
    [key]: value
  };
}

function buildOrderAttempts(stOrderNo) {
  const withoutPrefix = stOrderNo.replace(/^ST-/i, '');
  const values = unique([stOrderNo, withoutPrefix]);
  const attempts = [];

  for (const value of values) {
    attempts.push({
      method: 'getOrderRelation',
      biz: { refrence_no: value },
      trustSingleRecord: true
    });
  }

  for (const value of values) {
    for (const key of ORDER_LIST_CONDITION_KEYS) {
      attempts.push({
        method: 'getOrderList',
        biz: orderListBiz({ [key]: [value] }),
        trustSingleRecord: true
      });
    }
  }

  for (const value of values) {
    for (const key of ['stpo_code', 'reference_no', 'order_code']) {
      attempts.push({
        method: 'getStpoListNew',
        biz: stpoBiz(key, value),
        trustSingleRecord: true
      });
    }
  }

  for (const value of values) {
    attempts.push({
      method: 'getOrderInfo',
      biz: { warehouse_order_code: value },
      trustSingleRecord: true
    });
  }

  return attempts;
}

function scoreParsed(parsed) {
  if (!parsed?.found) return 0;
  let score = 100;
  if (parsed.trackingNo) score += 50;
  if (parsed.products?.length) score += 30;
  if (parsed.address?.countryCode) score += 15;
  if (parsed.address?.postcode) score += 15;
  if (parsed.address?.address1) score += 15;
  if (parsed.warehouseOrderNo) score += 12;
  if (parsed.warehouseCode) score += 8;
  if (parsed.platform) score += 5;
  return score;
}

function betterParsed(left, right) {
  return scoreParsed(right) > scoreParsed(left) ? right : left;
}

function hasCreationInputs(parsed) {
  return Boolean(
    parsed?.found &&
    parsed.trackingNo &&
    parsed.products?.length &&
    parsed.address?.countryCode &&
    parsed.address?.postcode
  );
}

function hasQuoteInputs(parsed) {
  return Boolean(
    parsed?.found &&
    parsed.products?.length &&
    parsed.address?.countryCode &&
    (parsed.warehouseCode || parsed.warehouse || parsed.warehouseOrderNo)
  );
}

async function runEccangAttempt(attempt, stOrderNo, responses) {
  const response = await eccangCall(attempt.method, attempt.biz);
  responses.push(response);
  const parsed = parseEccangPayload(response.json, stOrderNo, attempt.method, {
    trustSingleRecord: attempt.trustSingleRecord
  });
  if (!response.ok || !(apiSuccess(response.json) || response.json?.data || response.json?.result)) {
    return null;
  }
  return parsed.found ? parsed : null;
}

async function enrichParsedOrder(parsed, stOrderNo, responses) {
  let best = parsed;
  const orderCodes = unique([...(parsed.orderCodeCandidates || []), parsed.orderCode]);
  const warehouseOrderCodes = unique([...(parsed.warehouseOrderCandidates || []), parsed.warehouseOrderNo]);

  for (const orderCode of orderCodes) {
    if (hasCreationInputs(best)) break;
    const detail = await runEccangAttempt({
      method: 'getOrderList',
      biz: orderListBiz({ order_code_list: [orderCode] }),
      trustSingleRecord: true
    }, stOrderNo, responses);
    best = betterParsed(best, detail);
    for (const candidate of detail?.warehouseOrderCandidates || []) {
      if (!warehouseOrderCodes.includes(candidate)) warehouseOrderCodes.push(candidate);
    }
  }

  for (const warehouseOrderCode of warehouseOrderCodes) {
    if (hasCreationInputs(best)) break;
    const detail = await runEccangAttempt({
      method: 'getOrderInfo',
      biz: { warehouse_order_code: warehouseOrderCode },
      trustSingleRecord: true
    }, stOrderNo, responses);
    best = betterParsed(best, detail);
  }

  return best;
}

async function tryOrderQueries(stOrderNo, options = {}) {
  const responses = [];
  let best = null;
  for (const attempt of buildOrderAttempts(stOrderNo)) {
    const parsed = await runEccangAttempt(attempt, stOrderNo, responses);
    if (parsed?.found) {
      best = betterParsed(best, await enrichParsedOrder(parsed, stOrderNo, responses));
      if (options.quoteMode && hasQuoteInputs(best) && !best.warehouseOrderNo) return { parsed: best, responses };
      if (hasCreationInputs(best)) return { parsed: best, responses };
    }
  }
  return { parsed: best, responses };
}

async function queryEccangOrderApi(rawOrderNo, options = {}) {
  const stOrderNo = normalizeOrderNo(rawOrderNo);
  const { parsed, responses } = await tryOrderQueries(stOrderNo, options);
  if (parsed) return parsed;
  const last = responses[responses.length - 1] || {};
  return {
    stOrderNo,
    found: false,
    matched: false,
    source: 'eccang-api',
    trackingNo: '',
    trackingNumbers: [],
    warehouse: '',
    platform: '',
    warehouseOrderNo: '',
    products: [],
    address: {},
    attempts: responses.map(item => ({
      interfaceMethod: item.interfaceMethod,
      requestBizContent: item.requestBizContent,
      status: item.status,
      ok: item.ok,
      message: apiMessage(item.json, item.error || '')
    })).slice(-20),
    message: apiMessage(last.json, last.error || '易仓 API 未匹配到订单'),
    rawTextSnippet: safeSnippet(last.json || last.text || last.error || '', 2000)
  };
}

async function probeEccangApi() {
  try {
    requireConfig();
    const response = await eccangCall('getOrderList', { page: 1, pageSize: 1, page_size: 1 });
    return {
      platform: 'eccang',
      ok: response.ok && apiSuccess(response.json),
      mode: 'api',
      status: response.status,
      message: apiMessage(response.json, response.error || '易仓 API 已响应'),
      rawTextSnippet: safeSnippet(response.json || response.text, 1000)
    };
  } catch (error) {
    return {
      platform: 'eccang',
      ok: false,
      mode: 'api',
      error: error.message,
      message: `易仓 API 检查失败：${error.message}`
    };
  }
}

module.exports = {
  eccangCall,
  parseEccangPayload,
  probeEccangApi,
  queryEccangOrderApi,
  signParams
};
