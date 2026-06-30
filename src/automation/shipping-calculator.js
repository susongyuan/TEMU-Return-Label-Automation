const { compactText, includesQuery } = require('./common');
const { gotoPlatform } = require('./browser');
const { loginIfNeeded, looksLoggedIn } = require('./login');
const { config } = require('../env');

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

function orderProducts(order = {}) {
  const products = Array.isArray(order.products) && order.products.length
    ? order.products
    : [];
  if (products.length) return products;
  const sku = order.primarySku || order.warehouseSku || order.sku || order.productCode || '';
  return sku ? [{ sku, warehouseSku: sku, quantity: order.quantity || order.qty || 1 }] : [];
}

function orderAddress(order = {}) {
  const address = order.address || {};
  return {
    countryCode: address.countryCode || address.country || order.countryCode || order.country || '',
    state: address.state || order.state || '',
    city: address.city || order.city || '',
    postcode: address.postcode || address.zipCode || order.postcode || order.zipCode || '',
    rawTextSnippet: address.rawTextSnippet || order.rawTextSnippet || ''
  };
}

function firstNonEmpty(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function goodcangWarehouseCode(order = {}) {
  const explicit = firstNonEmpty(order.warehouseCode, order.gcWarehouseCode, order.warehouse_code);
  if (/^[A-Z0-9_-]{2,12}$/i.test(explicit)) return explicit.toUpperCase();

  const source = [
    order.warehouse,
    explicit,
    order.rawTextSnippet,
    ...(order.matchedRows || [])
  ].filter(Boolean).join(' ');
  const labelled = source.match(/(?:warehouse[_\s-]*code|仓库(?:编码|代码)?|发货仓库?|配送仓库?)[:：]?\s*([A-Z0-9_-]{2,12})/i)?.[1];
  if (labelled) return labelled.toUpperCase();
  const warehouse = source.match(/\b([A-Z]{2,6}(?:-\d+)?)\[[^\]]+仓\]/)?.[1];
  if (warehouse) return warehouse.toUpperCase();
  const pureCode = source.match(/\b([A-Z]{3,8}(?:-\d+)?)\b/)?.[1];
  if (pureCode && !/^(GOODCANG|RETURN|ORDER|SKU)$/i.test(pureCode)) return pureCode.toUpperCase();
  const region = source.match(/\b([A-Z]{2})\[[^\]]+区\]/)?.[1];
  return region || '';
}

function normalizeGoodcangCandidate(item) {
  const price = numericAmount(item.total_amount_with_vat, item.total_amount, item.amount, item.price);
  return {
    platform: 'goodcang',
    code: item.sm_code || item.code || '',
    name: item.sm_name || item.name || item.sm_code || '谷仓物流产品',
    price,
    currency: item.currency_code || item.currency || '',
    raw: {
      total_amount: item.total_amount,
      total_amount_with_vat: item.total_amount_with_vat,
      aging: item.aging,
      aging_end: item.aging_end,
      is_fast: item.is_fast,
      is_thrifty: item.is_thrifty
    }
  };
}

async function goodcangPost(page, path, data = {}, timeoutMs = 25000) {
  return page.evaluate(async ({ path, data, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify(data || {})
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, json, text };
    } catch (error) {
      return { ok: false, status: 0, json: null, text: '', error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }, { path, data, timeoutMs });
}

async function calculateGoodcangShipping(order = {}, page = null) {
  const targetPage = page || await gotoPlatform('goodcang', config.urls.goodcang);
  try {
    await loginIfNeeded(targetPage, 'goodcang');
  } catch (error) {
    if (!/login inputs not found/i.test(error.message) || !(await looksLoggedIn(targetPage, 'goodcang'))) {
      throw error;
    }
  }

  const products = orderProducts(order);
  const address = orderAddress(order);
  const warehouseCode = goodcangWarehouseCode(order);
  if (!warehouseCode || !products.length || !address.countryCode) {
    return {
      platform: 'goodcang',
      quoted: false,
      candidates: [],
      selected: null,
      message: '谷仓试算缺少仓库、SKU 或国家信息',
      input: { warehouseCode, products, address }
    };
  }

  const productList = products.map(item => ({
    product_sku: item.warehouseSku || item.sku,
    op_quantity: Number(item.quantity) || 1
  }));
  const payload = {
    warehouse_code: warehouseCode,
    address: {
      country_code: address.countryCode,
      state: address.state || '',
      city: address.city || '',
      postcode: address.postcode || ''
    },
    property_label: '',
    currency_code: '',
    _input_type: 'choose',
    product_list: productList,
    sm_code: '',
    is_residential: 1,
    is_signature: 0,
    is_insurance: 0
  };

  const response = await goodcangPost(targetPage, '/tool/freight_trail/sku_trail', payload, 25000);
  const responseMessage =
    response.error ||
    response.json?.message ||
    response.json?.msg ||
    response.json?.error ||
    response.json?.data?.message ||
    '';
  const looksLikeLogin = /login|登录|验证码|captcha/i.test(`${response.text || ''} ${responseMessage}`);
  const businessFailed = response.json && (
    response.json.code === 401 ||
    response.json.code === 403 ||
    response.json.code === false ||
    response.json.ask === 0 ||
    response.json.ask === false ||
    response.json.status === false ||
    response.json.success === false
  );
  if (!response.ok || response.error || looksLikeLogin || businessFailed) {
    return {
      platform: 'goodcang',
      quoted: false,
      payload,
      candidates: [],
      selected: null,
      message: looksLikeLogin
        ? '谷仓运费计算器请求失败：登录态失效或需要验证码'
        : `谷仓运费计算器请求失败：${responseMessage || `HTTP ${response.status}`}`,
      rawTextSnippet: compactText(response.text).slice(0, 1000)
    };
  }
  const data = response.json?.data || {};
  const list = Array.isArray(data.list) ? data.list : Array.isArray(data) ? data : [];
  const candidates = list.map(normalizeGoodcangCandidate)
    .filter(item => item.code || item.name)
    .sort((left, right) => (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER));
  const selected = chooseCheapest(candidates);
  return {
    platform: 'goodcang',
    quoted: candidates.length > 0,
    payload,
    candidates,
    selected,
    failedList: data.failed_list || [],
    message: candidates.length ? '谷仓运费计算器已返回报价' : '谷仓运费计算器未返回可用物流',
    rawTextSnippet: compactText(response.text).slice(0, 2000)
  };
}

function winitCountryCode(order = {}) {
  return order.address?.countryCode || order.address?.country || order.buyerCountryCode || order.countryCode || order.country || '';
}

function winitOrderAddress(order = {}) {
  const address = orderAddress(order);
  return {
    ...address,
    countryCode: address.countryCode || order.buyerCountryCode || '',
    state: address.state || order.buyerState || '',
    city: address.city || order.buyerCity || '',
    postcode: address.postcode || order.buyerPostcode || ''
  };
}

function normalizeWinitCandidate(item) {
  const price = numericAmount(item.totalAmount, item.totalAmountWithVat, item.amount, item.price);
  return {
    platform: 'winit',
    code: item.winitProductCode || item.productCode || item.pscCode || '',
    name: item.winitProductName || item.productName || item.name || item.winitProductCode || '万邑通物流产品',
    price,
    currency: item.currency || item.currencyCode || item.totalAmountCurrencyCode || '',
    raw: {
      sla: item.sla,
      outboundType: item.outboundType,
      feeDetail: item.feeDetail
    }
  };
}

async function winitPost(page, api, formPayload = {}, endpoint = '/App/ajaxProcess', timeoutMs = 25000) {
  return page.evaluate(async ({ api, formPayload, endpoint, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const form = new URLSearchParams();
    form.set('api', api);
    form.set('jsondata', 'true');
    form.set('form', JSON.stringify(formPayload || {}));
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: form.toString(),
        credentials: 'include',
        signal: controller.signal
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, json, text };
    } catch (error) {
      return { ok: false, status: 0, json: null, text: '', error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }, { api, formPayload, endpoint, timeoutMs });
}

async function calculateWinitShipping(order = {}, page = null) {
  const targetPage = page || await gotoPlatform('winit', config.urls.winit);
  await loginIfNeeded(targetPage, 'winit');
  const products = orderProducts(order);
  const address = winitOrderAddress(order);
  const packageInfo = order.packageInfo || {};
  const warehouseCode = packageInfo.warehouseCode || order.warehouseCode || '';
  const country = winitCountryCode(order) || address.countryCode;
  if (!warehouseCode || !country) {
    return {
      platform: 'winit',
      quoted: false,
      candidates: [],
      selected: null,
      message: '万邑通试算缺少仓库或国家信息',
      input: { warehouseCode, country, address, products }
    };
  }

  const merchandiseList = products.length
    ? products.map(item => ({
      merchandiseCode: item.warehouseSku || item.sku,
      qty: Number(item.quantity) || 1
    }))
    : [{ length: 10, width: 10, height: 2, weight: 0.2, qty: 1 }];
  const payload = {
    warehouseCode,
    country,
    zipCode: address.postcode || order.zipCode || '',
    state: address.state || '',
    city: address.city || '',
    merchandiseList,
    uuid: `return-label-${Date.now()}`
  };
  const response = await winitPost(targetPage, 'wh.outbound.deliveryFeeCalculator', payload);
  const data = response.json?.data || {};
  const usable = Array.isArray(data.usableProductList) ? data.usableProductList : [];
  const candidates = usable.map(normalizeWinitCandidate)
    .filter(item => item.code || item.name)
    .sort((left, right) => (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER));
  const selected = chooseCheapest(candidates);
  return {
    platform: 'winit',
    quoted: candidates.length > 0,
    payload,
    candidates,
    selected,
    unusableProductList: data.unusableProductList || [],
    message: candidates.length ? '万邑通费用计算器已返回报价' : '万邑通费用计算器未返回可用产品',
    rawTextSnippet: compactText(response.text).slice(0, 2000)
  };
}

function matchCandidateByText(candidates = [], text = '') {
  const source = String(text || '');
  return candidates.find(candidate =>
    (candidate.code && includesQuery(source, candidate.code)) ||
    (candidate.name && includesQuery(source, candidate.name))
  ) || null;
}

module.exports = {
  calculateGoodcangShipping,
  calculateWinitShipping,
  chooseCheapest,
  matchCandidateByText
};
