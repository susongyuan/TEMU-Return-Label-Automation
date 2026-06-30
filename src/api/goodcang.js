const { config } = require('../env');
const {
  apiMessage,
  apiSuccess,
  asArray,
  collectObjects,
  compactText,
  fetchJson,
  firstNonEmpty,
  numericAmount,
  safeSnippet,
  saveBase64Label
} = require('./common');

function requireConfig() {
  const missing = [];
  if (!config.api.goodcang.appToken) missing.push('GOODCANG_APP_TOKEN');
  if (!config.api.goodcang.appKey) missing.push('GOODCANG_APP_KEY');
  if (missing.length) {
    throw new Error(`谷仓 API 缺少配置：${missing.join(', ')}`);
  }
}

function goodcangUrl(path) {
  return `${String(config.api.goodcang.baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

async function goodcangCall(path, payload = {}) {
  requireConfig();
  const response = await fetchJson(goodcangUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'app-token': config.api.goodcang.appToken,
      'app-key': config.api.goodcang.appKey
    },
    body: JSON.stringify(payload || {}),
    timeoutMs: 30000
  });
  return {
    path,
    payload,
    ok: response.ok,
    status: response.status,
    json: response.json,
    text: response.text,
    error: response.error
  };
}

function gcData(json) {
  return parseMaybeJson(json?.data ?? json?.result ?? json);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!/^[{[]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function dataList(value) {
  const data = gcData(value);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.items)) return data.items;
  return data && typeof data === 'object' ? [data] : [];
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
      if (
        normalized.includes(String(key).toLowerCase()) &&
        item !== undefined &&
        item !== null &&
        String(item) !== ''
      ) {
        return item;
      }
    }
    for (const item of Object.values(current)) {
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  return '';
}

function goodcangMessage(json, fallback = '') {
  return firstNonEmpty(
    apiMessage(json, ''),
    json?.error?.message,
    json?.Error?.message,
    json?.error?.errCode,
    json?.Error?.errCode,
    fallback
  );
}

function firstArray(...values) {
  return values.find(value => Array.isArray(value) && value.length) || [];
}

function fieldList(items) {
  return items.filter(Boolean).join('、');
}

function normalizeProducts(order = {}) {
  const source = order.raw || order;
  const sourceProducts =
    (Array.isArray(order.products) && order.products.length ? order.products : null) ||
    (Array.isArray(order.items) && order.items.length ? order.items : null) ||
    (Array.isArray(order.orderBoxInfo) && order.orderBoxInfo.length ? order.orderBoxInfo : null) ||
    firstArray(
      source.product_detail,
      source.productDetail,
      source.product_list,
      source.productList,
      source.products,
      source.items,
      source.orderBoxInfo
    );
  const productObjects = sourceProducts.length
    ? sourceProducts
    : collectObjects(source, item =>
      Boolean(
        item.product_sku ||
        item.productSku ||
        item.sku ||
        item.warehouseSku ||
        item.warehouse_sku ||
        item.product_barcode ||
        item.productBarcode ||
        item.productCode ||
        item.product_code
      )
    );
  const products = productObjects.map(item => {
    const sku = firstNonEmpty(
      item.product_sku,
      item.productSku,
      item.sku,
      item.warehouseSku,
      item.warehouse_sku,
      item.product_barcode,
      item.productBarcode,
      item.productCode,
      item.product_code,
      item.goods_sku,
      item.item_sku
    );
    const quantity = Number(firstNonEmpty(
      item.quantity,
      item.qty,
      item.num,
      item.ob_qty,
      item.op_quantity,
      item.productNum,
      item.product_num,
      item.product_qty,
      1
    )) || 1;
    return {
      sku,
      warehouseSku: firstNonEmpty(
        item.warehouseSku,
        item.warehouse_sku,
        item.product_barcode,
        item.productBarcode,
        item.productCode,
        item.product_code,
        sku
      ),
      quantity
    };
  }).filter(item => item.sku || item.warehouseSku);
  const fallbackSku = firstNonEmpty(order.primarySku, order.warehouseSku, order.sku, order.product_sku);
  if (!products.length && fallbackSku) {
    products.push({ sku: fallbackSku, warehouseSku: fallbackSku, quantity: Number(order.quantity) || 1 });
  }
  const seen = new Set();
  return products.filter(item => {
    const key = `${item.sku}|${item.warehouseSku}|${item.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAddress(order = {}) {
  const source = order.raw || order;
  const address = order.address && typeof order.address === 'object'
    ? order.address
    : collectObjects(source, item =>
      Boolean(
        item.country_code ||
        item.countryCode ||
        item.consignee_country_code ||
        item.receiver_country_code ||
        item.postcode ||
        item.zipcode ||
        item.zip_code ||
        item.address1 ||
        item.street1 ||
        item.consignee_address1
      )
    )[0] || {};
  return {
    name: firstNonEmpty(
      address.name,
      address.consignee_name,
      address.receiverName,
      order.consignee_name,
      order.consigneeName,
      order.receiverName,
      'customer'
    ),
    lastName: firstNonEmpty(address.lastName, address.last_name, order.consignee_last_name),
    phone: firstNonEmpty(address.phone, order.consignee_phone, order.phone, '0000000000'),
    email: firstNonEmpty(address.email, order.consignee_email, order.email, 'return@example.com'),
    countryCode: String(firstNonEmpty(
      address.countryCode,
      address.country_code,
      address.consignee_country_code,
      address.receiver_country_code,
      order.consignee_country_code,
      order.countryCode,
      order.country
    )).toUpperCase(),
    state: firstNonEmpty(address.state, order.consignee_state, order.state),
    city: firstNonEmpty(address.city, order.consignee_city, order.city),
    postcode: firstNonEmpty(
      address.postcode,
      address.zipcode,
      address.zip_code,
      address.consignee_zipcode,
      order.consigne_zipcode,
      order.consignee_zipcode,
      order.postcode,
      order.zipCode
    ),
    address1: firstNonEmpty(address.address1, address.street1, address.address, order.consignee_address1, order.address1, 'unknown'),
    address2: firstNonEmpty(address.address2, address.street2, order.consignee_address2, order.address2),
    company: firstNonEmpty(address.company, order.company)
  };
}

function normalizeGoodcangOrder(record = {}, trackingNo = '') {
  const order = dataList(record).find(item =>
    firstDeepValue(item, ['order_code', 'orderCode', 'warehouseOrderNo', 'tracking_no', 'trackingNo'])
  ) || gcData(record) || {};
  const products = normalizeProducts(order);
  const address = normalizeAddress(order);
  const warehouseOrderNo = firstNonEmpty(
    order.order_code,
    order.orderCode,
    order.warehouseOrderNo,
    firstDeepValue(order, ['order_code', 'orderCode', 'warehouseOrderNo'])
  );
  const track = firstNonEmpty(
    trackingNo,
    order.tracking_no,
    order.trackingNo,
    order.orderBoxInfo?.[0]?.tracking_number,
    firstDeepValue(order, ['tracking_no', 'trackingNo', 'tracking_number', 'trackingNumber'])
  );
  const warehouseCode = firstNonEmpty(
    order.warehouse_code,
    order.warehouseCode,
    firstDeepValue(order, ['warehouse_code', 'warehouseCode'])
  );
  return {
    platform: 'goodcang',
    source: 'goodcang-api',
    found: Boolean(warehouseOrderNo || track),
    warehouseOrderNo,
    warehouseOrderCandidates: [warehouseOrderNo].filter(Boolean),
    warehouse: firstNonEmpty(order.warehouse_name, order.warehouseName, warehouseCode),
    warehouseCode,
    trackingNo: track,
    trackingNumbers: [
      track,
      ...asArray(order.orderBoxInfo).map(item => firstNonEmpty(item?.tracking_number, item?.trackingNo)).filter(Boolean)
    ].filter(Boolean),
    referenceNo: firstNonEmpty(order.reference_no, order.referenceNo),
    shippingMethod: firstNonEmpty(order.shipping_method, order.shippingMethod, order.sm_code, order.smCode),
    orderStatus: firstNonEmpty(order.order_status, order.orderStatus),
    products,
    primarySku: products[0]?.warehouseSku || products[0]?.sku || '',
    quantity: products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1,
    address,
    raw: order,
    rawTextSnippet: safeSnippet(order, 4000)
  };
}

function normalizeTrackingStatus(json, trackingNo) {
  const records = dataList(json);
  const match = collectObjects(records, item =>
    Boolean(item.order_code || item.orderCode || item.order_no || item.orderNo || item.tracking_number || item.trackingNo || item.tracking_no)
  ).find(item => {
    const text = compactText(JSON.stringify(item));
    return !trackingNo || text.toUpperCase().includes(String(trackingNo).toUpperCase());
  });
  return firstNonEmpty(match?.order_code, match?.orderCode, match?.order_no, match?.orderNo, firstDeepValue(match, ['order_code', 'orderCode', 'order_no', 'orderNo']));
}

async function getOrderByCode(orderCode) {
  if (!orderCode) return null;
  const response = await goodcangCall('/order/get_order_by_code', { order_code: orderCode });
  if (!response.ok || !apiSuccess(response.json)) {
    return { response, order: null };
  }
  return {
    response,
    order: normalizeGoodcangOrder(response.json)
  };
}

async function findGoodcangOrderApi({ trackingNo, orderCode, warehouseOrderNo } = {}) {
  const directCode = firstNonEmpty(orderCode, warehouseOrderNo);
  if (directCode) {
    const direct = await getOrderByCode(directCode);
    if (direct?.order?.found) return direct.order;
  }
  if (!trackingNo) {
    return {
      platform: 'goodcang',
      found: false,
      source: 'goodcang-api',
      message: '缺少易仓跟踪号，跳过谷仓 API 查询'
    };
  }

  const tracking = await goodcangCall('/order/batch_query_tracking_status', {
    value_list: [trackingNo],
    code_type: 'tracking_number'
  });
  const foundCode = tracking.ok && apiSuccess(tracking.json)
    ? normalizeTrackingStatus(tracking.json, trackingNo)
    : '';
  if (foundCode) {
    const detail = await getOrderByCode(foundCode);
    if (detail?.order?.found) {
      return {
        ...detail.order,
        trackingNo,
        trackingNumbers: [...new Set([trackingNo, ...(detail.order.trackingNumbers || [])])]
      };
    }
  }
  return {
    platform: 'goodcang',
    found: false,
    source: 'goodcang-api',
    trackingNo,
    message: apiMessage(tracking.json, tracking.error || '谷仓 API 未通过跟踪号匹配到订单'),
    rawTextSnippet: safeSnippet(tracking.json || tracking.text || tracking.error, 2000)
  };
}

function normalizeGoodcangQuoteItem(item, currency = '') {
  const price = numericAmount(
    item.total,
    item.total_amount_with_vat,
    item.totalAmountWithVat,
    item.total_amount,
    item.totalAmount,
    item.amount,
    item.price,
    item.fee,
    item.cost,
    item.shipping_fee,
    item.shippingFee
  );
  const code = firstNonEmpty(
    item.sm_code,
    item.smCode,
    item.shipping_method,
    item.shippingMethod,
    item.shipping_method_code,
    item.code,
    item.courier
  );
  return {
    platform: 'goodcang',
    code,
    name: firstNonEmpty(
      item.sm_name_cn,
      item.smNameCn,
      item.sm_name,
      item.smName,
      item.shipping_method_name,
      item.shippingMethodName,
      item.name,
      code,
      '谷仓物流产品'
    ),
    price,
    currency: firstNonEmpty(item.currency_code, item.currency, currency, 'USD'),
    raw: item
  };
}

function normalizeGoodcangShippingMethod(item = {}) {
  const type = firstNonEmpty(item.type, item.shipping_method_type, item.shippingMethodType);
  const warehouseCode = firstNonEmpty(item.warehouse_code, item.warehouseCode);
  const code = firstNonEmpty(
    item.code,
    item.sm_code,
    item.smCode,
    item.shipping_method,
    item.shippingMethod,
    item.shipping_method_code
  );
  const name = firstNonEmpty(
    item.name,
    item.name_cn,
    item.name_en,
    item.sm_name_cn,
    item.smNameCn,
    item.sm_name,
    item.smName,
    code,
    '谷仓退货物流产品'
  );
  return {
    platform: 'goodcang',
    code,
    name,
    price: null,
    currency: '',
    type: type === '' ? '' : String(type),
    warehouseCode,
    returnService: String(type) === '1',
    source: 'shipping-method',
    raw: item
  };
}

function quoteItems(json) {
  const data = gcData(json);
  const direct = dataList(json);
  const source = direct.length > 1 ? direct : collectObjects(data, item =>
    Boolean(
      item.sm_code ||
      item.smCode ||
      item.shipping_method ||
      item.shippingMethod ||
      item.shipping_method_code ||
      item.code ||
      item.courier
    )
  );
  return source.filter(item => item && typeof item === 'object');
}

function sameGoodcangCandidate(left = {}, right = {}) {
  const leftCode = compactText(firstNonEmpty(left.code, left.raw?.code, left.raw?.sm_code, left.raw?.smCode)).toUpperCase();
  const rightCode = compactText(firstNonEmpty(right.code, right.raw?.code, right.raw?.sm_code, right.raw?.smCode)).toUpperCase();
  if (leftCode && rightCode && leftCode === rightCode) return true;
  const leftName = compactText(firstNonEmpty(left.name, left.raw?.name, left.raw?.sm_name, left.raw?.smName)).toUpperCase();
  const rightName = compactText(firstNonEmpty(right.name, right.raw?.name, right.raw?.sm_name, right.raw?.smName)).toUpperCase();
  return Boolean(leftName && rightName && (leftName.includes(rightName) || rightName.includes(leftName)));
}

function uniqueGoodcangCandidates(candidates = []) {
  const unique = [];
  for (const candidate of candidates) {
    if (candidate && !unique.some(item => sameGoodcangCandidate(item, candidate))) unique.push(candidate);
  }
  return unique;
}

function hasGoodcangPrice(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return false;
  return candidate.price !== null &&
    candidate.price !== undefined &&
    candidate.price !== '' &&
    Number.isFinite(Number(candidate.price));
}

function sortGoodcangCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftPrice = Number(left.price);
    const rightPrice = Number(right.price);
    const leftHasPrice = hasGoodcangPrice(left);
    const rightHasPrice = hasGoodcangPrice(right);
    if (leftHasPrice && rightHasPrice) return leftPrice - rightPrice;
    if (leftHasPrice) return -1;
    if (rightHasPrice) return 1;
    return 0;
  });
}

function chooseCheapestGoodcang(candidates = []) {
  return sortGoodcangCandidates(candidates).find(hasGoodcangPrice) || null;
}

const GOODCANG_FEE_MATCH_THRESHOLD = 10;
const GOODCANG_EXCLUDED_LOGISTICS = ['UK_DHL_LOC_RETURN'];
const GOODCANG_PLATFORM_LOGISTICS = '0';
const GOODCANG_CUSTOM_LOGISTICS = '1';

function goodcangSearchText(...values) {
  return compactText(values.filter(Boolean).join(' '))
    .toUpperCase()
    .replace(/[【】\[\]()（）{}]/g, ' ')
    .replace(/[_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasGoodcangTerm(text, term) {
  if (!text || !term) return false;
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(text);
}

function goodcangDisplayText(candidate = {}) {
  return goodcangSearchText(
    candidate.name,
    candidate.raw?.name,
    candidate.raw?.name_cn,
    candidate.raw?.name_en,
    candidate.raw?.sm_name,
    candidate.raw?.smName,
    candidate.raw?.sm_name_cn,
    candidate.raw?.shipping_method_name,
    candidate.raw?.shippingMethodName
  );
}

function goodcangAllText(candidate = {}) {
  return goodcangSearchText(
    candidate.code,
    candidate.name,
    candidate.raw?.code,
    candidate.raw?.sm_code,
    candidate.raw?.smCode,
    candidate.raw?.shipping_method,
    candidate.raw?.shippingMethod,
    candidate.raw?.shipping_method_code,
    candidate.raw?.courier,
    candidate.raw?.name,
    candidate.raw?.name_cn,
    candidate.raw?.name_en,
    candidate.raw?.sm_name,
    candidate.raw?.smName,
    candidate.raw?.sm_name_cn,
    candidate.raw?.shipping_method_name,
    candidate.raw?.shippingMethodName
  );
}

function carrierTokensFromText(text = '') {
  const tokens = new Set();
  const push = token => {
    if (token) tokens.add(token);
  };
  const source = goodcangSearchText(text);
  if (hasGoodcangTerm(source, 'EVRI') || hasGoodcangTerm(source, 'HERMES') || hasGoodcangTerm(source, 'UKH')) push('EVRI');
  if (hasGoodcangTerm(source, 'DHL')) push('DHL');
  if (hasGoodcangTerm(source, 'YODEL')) push('YODEL');
  if (hasGoodcangTerm(source, 'XDP')) push('XDP');
  if (
    hasGoodcangTerm(source, 'RM') ||
    hasGoodcangTerm(source, 'ROYAL') ||
    hasGoodcangTerm(source, 'ROYALMAIL') ||
    hasGoodcangTerm(source, 'TRACKED') ||
    /皇家邮政/.test(source)
  ) push('ROYAL');
  if (hasGoodcangTerm(source, 'UPS')) push('UPS');
  if (hasGoodcangTerm(source, 'DX')) push('DX');
  if (hasGoodcangTerm(source, 'PALLETWAYS') || hasGoodcangTerm(source, 'PALLET') || /托盘/.test(source)) push('PALLETWAYS');
  return [...tokens];
}

function goodcangCarrierTokens(candidate = {}, { preferDisplay = false } = {}) {
  const displayTokens = carrierTokensFromText(goodcangDisplayText(candidate));
  if (preferDisplay && displayTokens.length) return displayTokens;
  const allTokens = carrierTokensFromText(goodcangAllText(candidate));
  return allTokens.length ? allTokens : displayTokens;
}

function goodcangServiceTokens(candidate = {}, { preferDisplay = false } = {}) {
  const text = preferDisplay && goodcangDisplayText(candidate)
    ? goodcangDisplayText(candidate)
    : goodcangAllText(candidate);
  const tokens = new Set();
  const push = token => {
    if (token) tokens.add(token);
  };
  if (/经济|ECONOMY|ECONOMIC/.test(text)) push('ECONOMY');
  if (/本地|LOCAL/.test(text)) push('LOCAL');
  if (/大货|LARGE|BULKY|TOW\s*MAN|TOWMAN/.test(text)) push('LARGE');
  if (/商店|包裹站|SHOP|PARCELSHOP|DROP\s*OFF/.test(text)) push('SHOP');
  if (/上门|COURIER|PICK\s*UP|COLLECT/.test(text)) push('HOME');
  if (/标准|STANDARD|STD/.test(text)) push('STANDARD');
  if (/包裹|PARCEL|PACKET/.test(text)) push('PARCEL');
  if (/EXPRESS|快递/.test(text)) push('EXPRESS');
  if (/48\s*H|48小时|48H/.test(text)) push('48H');
  return [...tokens];
}

function intersection(left = [], right = []) {
  return left.filter(item => right.includes(item));
}

function normalizedGoodcangCode(candidate = {}) {
  return goodcangSearchText(
    firstNonEmpty(candidate.code, candidate.raw?.code, candidate.raw?.sm_code, candidate.raw?.smCode)
  ).replace(/\s+/g, '');
}

function normalizedGoodcangLogisticsText(value = '') {
  return goodcangSearchText(value).replace(/\s+/g, '');
}

function isExcludedGoodcangLogistics(candidate = {}) {
  const excludedCodes = GOODCANG_EXCLUDED_LOGISTICS.map(normalizedGoodcangLogisticsText);
  if (!candidate) return false;
  if (typeof candidate === 'string') {
    const text = normalizedGoodcangLogisticsText(candidate);
    return excludedCodes.some(code => text === code || text.includes(code));
  }
  if (typeof candidate !== 'object') return isExcludedGoodcangLogistics(String(candidate));
  const code = normalizedGoodcangCode(candidate);
  const text = normalizedGoodcangLogisticsText(goodcangAllText(candidate));
  return excludedCodes.some(excluded => code === excluded || text === excluded || text.includes(excluded));
}

function goodcangWordTokens(candidate = {}) {
  return [
    ...goodcangCarrierTokens(candidate, { preferDisplay: false }),
    ...goodcangServiceTokens(candidate, { preferDisplay: false })
  ];
}

function scoreGoodcangPriceMatch(returnCandidate = {}, feeCandidate = {}) {
  const returnCode = normalizedGoodcangCode(returnCandidate).replace(/RETURN.*/g, '');
  const feeCode = normalizedGoodcangCode(feeCandidate);
  const returnCarriers = goodcangCarrierTokens(returnCandidate, { preferDisplay: true });
  const feeCarriers = goodcangCarrierTokens(feeCandidate, { preferDisplay: false });
  const carrierOverlap = intersection(returnCarriers, feeCarriers);
  const hasCarrierConflict = returnCarriers.length && feeCarriers.length && !carrierOverlap.length;
  if (hasCarrierConflict) return 0;

  const returnServices = goodcangServiceTokens(returnCandidate, { preferDisplay: true });
  const feeServices = goodcangServiceTokens(feeCandidate, { preferDisplay: false });
  const serviceOverlap = intersection(returnServices, feeServices);
  let score = 0;

  if (carrierOverlap.length) score += 8;
  if (returnCode && feeCode && returnCode === feeCode) score += 6;
  if (returnCode && feeCode && returnCode !== feeCode && (feeCode.includes(returnCode) || returnCode.includes(feeCode))) score += 3;

  for (const token of serviceOverlap) {
    score += ['ECONOMY', 'LOCAL', 'LARGE', 'SHOP'].includes(token) ? 3 : 2;
  }

  const returnWords = goodcangWordTokens(returnCandidate);
  const feeWords = goodcangWordTokens(feeCandidate);
  const wordOverlap = intersection([...new Set(returnWords)], [...new Set(feeWords)]).length;
  score += Math.min(3, wordOverlap);

  if (carrierOverlap.length && returnServices.length && feeServices.length && !serviceOverlap.length) {
    score -= 3;
  }

  return Math.max(0, score);
}

function candidateKey(candidate = {}) {
  return compactText(firstNonEmpty(candidate.code, candidate.name)).toUpperCase();
}

function rankGoodcangReturnCandidatesByFee(officialCandidates = [], feeCandidates = []) {
  const ranked = [];
  const used = new Set();
  const officialReturnCandidates = officialCandidates.filter(candidate => !isExcludedGoodcangLogistics(candidate));
  const pricedFeeCandidates = sortGoodcangCandidates(feeCandidates)
    .filter(candidate => hasGoodcangPrice(candidate) && !isExcludedGoodcangLogistics(candidate));

  for (const feeCandidate of pricedFeeCandidates) {
    const match = officialReturnCandidates
      .filter(candidate => !used.has(candidateKey(candidate)))
      .map(candidate => ({
        candidate,
        score: scoreGoodcangPriceMatch(candidate, feeCandidate)
      }))
      .filter(item => item.score >= GOODCANG_FEE_MATCH_THRESHOLD)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return officialReturnCandidates.indexOf(left.candidate) - officialReturnCandidates.indexOf(right.candidate);
      })[0]?.candidate;
    if (!match) continue;
    used.add(candidateKey(match));
    ranked.push({
      ...match,
      price: feeCandidate.price,
      currency: feeCandidate.currency,
      priceSource: 'fee-calculator',
      priceMatchScore: scoreGoodcangPriceMatch(match, feeCandidate),
      priceMatchedLogistics: {
        code: feeCandidate.code,
        name: feeCandidate.name,
        price: feeCandidate.price,
        currency: feeCandidate.currency
      }
    });
  }

  const unpriced = officialReturnCandidates
    .filter(candidate => !used.has(candidateKey(candidate)))
    .map(candidate => ({
      ...candidate,
      price: null,
      currency: '',
      priceSource: '',
      priceMatchScore: 0
    }));
  return [...ranked, ...unpriced];
}

function chooseGoodcangCourier(quote = {}, order = {}) {
  const candidates = sortGoodcangCandidates(
    (quote.candidates || []).filter(candidate => !isExcludedGoodcangLogistics(candidate))
  );
  const preferred = firstNonEmpty(
    order.preferredReturnCourier,
    order.customerReturnCarrierName,
    order.returnCourier,
    order.courier,
    order.shippingMethod,
    order.sm_code,
    order.smCode
  );
  const preferredIsExcluded = isExcludedGoodcangLogistics(preferred);
  const preferredText = compactText(preferred);
  const matched = preferredText && !preferredIsExcluded
    ? candidates.find(item =>
      compactText(item.code).toUpperCase() === preferredText.toUpperCase() ||
      compactText(item.name).toUpperCase() === preferredText.toUpperCase() ||
      compactText(item.code).toUpperCase().includes(preferredText.toUpperCase()) ||
      compactText(item.name).toUpperCase().includes(preferredText.toUpperCase())
    )
    : null;
  if (matched) return matched;
  const cheapest = chooseCheapestGoodcang(candidates);
  if (cheapest) return cheapest;
  return preferred && !preferredIsExcluded
    ? {
      platform: 'goodcang',
      code: preferred,
      name: preferred,
      price: null,
      currency: '',
      source: 'order'
    }
    : null;
}

function hasPreferredGoodcangCourier(order = {}) {
  return Boolean(compactText(firstNonEmpty(
    order.preferredReturnCourier,
    order.preferredCourier,
    order.preferredLogistics,
    order.customerReturnCarrierName,
    order.returnCourier,
    order.courier,
    order.shippingMethod,
    order.sm_code,
    order.smCode
  )));
}

function uniqueGoodcangSelection(candidates = []) {
  const used = new Set();
  return candidates.filter(candidate => {
    if (!candidate || (!candidate.code && !candidate.name)) return false;
    const key = candidateKey(candidate);
    if (used.has(key)) return false;
    used.add(key);
    return true;
  });
}

function normalizeManualGoodcangLogistics(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const code = firstNonEmpty(value.code, value.channelCode, value.serviceCode);
  const name = firstNonEmpty(value.name, value.channelName, value.logisticsName, value.serviceName, code);
  if (!code && !name) return null;
  return {
    ...value,
    platform: 'goodcang',
    code,
    name,
    price: value.price ?? null,
    currency: value.currency || '',
    returnService: value.returnService !== false,
    source: value.source || 'manual-selected-logistics'
  };
}

function goodcangCustomerReturnTrackingNo(order = {}) {
  return firstNonEmpty(
    order.customerReturnTrackingNo,
    order.returnExpressNo,
    order.expressNo,
    order.returnTrackingNo
  );
}

function goodcangCustomerReturnCarrierName(order = {}) {
  return firstNonEmpty(
    order.customerReturnCarrierName,
    order.returnCarrierName,
    order.preferredReturnCourier,
    order.returnCourier,
    order.courier,
    order.supplierName,
    order.returnSupplierName
  );
}

function isGoodcangCustomReturnLogistics(order = {}) {
  const explicit = String(firstNonEmpty(order.returnLogisticsMode, order.logisticsMode)).trim().toLowerCase();
  if (['custom', 'self', 'manual', '自选', '自寄'].includes(explicit)) return true;
  if (['auto', 'platform', 'official', '平台', '官方', '代选'].includes(explicit)) return false;
  return Boolean(goodcangCustomerReturnTrackingNo(order) || goodcangCustomerReturnCarrierName(order));
}

function customGoodcangReturnCandidate(order = {}) {
  const carrierName = goodcangCustomerReturnCarrierName(order);
  if (!carrierName) return null;
  return {
    platform: 'goodcang',
    code: carrierName,
    name: carrierName,
    price: null,
    currency: '',
    returnService: true,
    selected: true,
    source: 'input-custom-logistics',
    customerReturnTrackingNo: goodcangCustomerReturnTrackingNo(order)
  };
}

async function resolveGoodcangCustomReturnCandidate(order = {}) {
  const fallback = customGoodcangReturnCandidate(order);
  if (!fallback) return null;

  const warehouseCode = firstNonEmpty(order.warehouseCode, order.warehouse_code, order.warehouse);
  const preferredCarrier = goodcangCustomerReturnCarrierName(order);
  const methods = await getGoodcangReturnShippingMethods(warehouseCode).catch(() => null);
  const candidates = sortGoodcangCandidates(
    (methods?.candidates || []).filter(item => !isExcludedGoodcangLogistics(item))
  );
  if (!candidates.length) return fallback;

  const matched = chooseGoodcangCourier({
    candidates
  }, {
    ...order,
    preferredReturnCourier: preferredCarrier,
    customerReturnCarrierName: preferredCarrier,
    returnCourier: preferredCarrier,
    courier: preferredCarrier,
    shippingMethod: preferredCarrier,
    sm_code: preferredCarrier,
    smCode: preferredCarrier
  });
  if (matched && !isExcludedGoodcangLogistics(matched)) {
    return {
      ...matched,
      selected: true,
      source: 'input-custom-logistics-match',
      customerReturnTrackingNo: goodcangCustomerReturnTrackingNo(order)
    };
  }

  const carrierTokens = carrierTokensFromText(preferredCarrier);
  const fuzzyMatched = candidates.find(candidate => {
    const candidateTokens = carrierTokensFromText(goodcangAllText(candidate));
    return candidateTokens.some(token => carrierTokens.includes(token));
  });
  if (fuzzyMatched) {
    return {
      ...fuzzyMatched,
      selected: true,
      source: 'input-custom-logistics-match',
      customerReturnTrackingNo: goodcangCustomerReturnTrackingNo(order)
    };
  }

  return fallback;
}

async function getGoodcangReturnShippingMethods(warehouseCode = '') {
  const response = await goodcangCall('/base_data/get_shipping_method', warehouseCode ? { warehouseCode } : {});
  const methods = response.ok && apiSuccess(response.json)
    ? dataList(response.json).map(normalizeGoodcangShippingMethod)
    : [];
  const filtered = methods.filter(item =>
    item.code &&
    item.returnService &&
    (!warehouseCode || !item.warehouseCode || item.warehouseCode === warehouseCode)
  );
  return {
    response,
    candidates: filtered,
    allCandidates: methods,
    message: filtered.length
      ? '谷仓 OpenAPI 已返回官方退货物流产品'
      : goodcangMessage(response.json, response.error || '谷仓 OpenAPI 未返回官方退货物流产品')
  };
}

async function quoteGoodcangCandidate(basePayload, candidate) {
  if (!candidate?.code) return null;
  const response = await goodcangCall('/inventory/get_calculate_delivery_fee', {
    ...basePayload,
    sm_code: candidate.code
  });
  if (!response.ok || !apiSuccess(response.json)) {
    return {
      ...candidate,
      quoteOk: false,
      quoteMessage: goodcangMessage(response.json, response.error || '谷仓 OpenAPI 试算该退货物流失败')
    };
  }
  const data = gcData(response.json);
  const item = quoteItems(response.json)[0];
  if (!item) {
    return {
      ...candidate,
      quoteOk: false,
      quoteMessage: goodcangMessage(response.json, response.error || '谷仓 OpenAPI 试算该退货物流未返回价格')
    };
  }
  const quoted = normalizeGoodcangQuoteItem(item, response.json?.currency || data?.currency);
  if (!sameGoodcangCandidate(candidate, quoted)) {
    return {
      ...candidate,
      quoteOk: false,
      quoteMessage: '谷仓 OpenAPI 试算返回的物流产品不是当前退货物流，价格仅用于后续服务商匹配',
      quoteReturnedLogistics: {
        code: quoted.code,
        name: quoted.name,
        price: quoted.price,
        currency: quoted.currency
      }
    };
  }
  return {
    ...candidate,
    ...quoted,
    code: firstNonEmpty(candidate.code, quoted.code),
    name: firstNonEmpty(candidate.name, quoted.name, candidate.code),
    type: candidate.type,
    warehouseCode: candidate.warehouseCode,
    returnService: true,
    source: 'return-shipping-method',
    quoteOk: true,
    raw: {
      method: candidate.raw,
      quote: quoted.raw
    }
  };
}

async function calculateGoodcangShippingApi(order = {}) {
  const products = normalizeProducts(order);
  const address = normalizeAddress(order);
  const warehouseCode = firstNonEmpty(order.warehouseCode, order.warehouse_code, order.warehouse);
  if (!warehouseCode || !address.countryCode || !address.postcode || !products.length) {
    return {
      platform: 'goodcang',
      quoted: false,
      candidates: [],
      selected: null,
      message: '谷仓 OpenAPI 试算缺少仓库、国家、邮编或 SKU',
      input: { warehouseCode, address, products }
    };
  }
  const payload = {
    warehouse_code: warehouseCode,
    country_code: address.countryCode,
    postcode: address.postcode,
    state: address.state || '',
    city: address.city || '',
    sku: products.map(item => {
      const sku = item.warehouseSku || item.sku;
      const quantity = Number(item.quantity) || 1;
      return quantity > 1 ? `${sku}:${quantity}` : sku;
    }),
    sm_code: '',
    is_residential: 0
  };
  const methods = await getGoodcangReturnShippingMethods(warehouseCode).catch(error => ({
    candidates: [],
    message: error.message
  }));
  const officialReturnMethods = methods.candidates || [];
  const response = await goodcangCall('/inventory/get_calculate_delivery_fee', payload);
  const data = gcData(response.json);
  const list = quoteItems(response.json);
  const deliveryCandidates = list.map(item => ({
    ...normalizeGoodcangQuoteItem(item, response.json?.currency || data?.currency),
    returnService: false,
    source: 'delivery-fee'
  }))
    .filter(item => item.code || item.name);
  const calculatorCandidates = sortGoodcangCandidates(deliveryCandidates);
  const returnCandidates = rankGoodcangReturnCandidatesByFee(
    uniqueGoodcangCandidates(officialReturnMethods),
    calculatorCandidates
  );
  const selected = chooseGoodcangCourier({ candidates: returnCandidates }, order);
  return {
    platform: 'goodcang',
    quoted: returnCandidates.length > 0 || calculatorCandidates.length > 0,
    payload,
    candidates: returnCandidates,
    returnCandidates: returnCandidates.slice(0, 20),
    selected,
    officialReturnCandidates: officialReturnMethods.slice(0, 20),
    calculatorCandidates,
    feeCandidates: calculatorCandidates,
    message: returnCandidates.length
      ? (returnCandidates.length
        ? '谷仓 OpenAPI 已按费用计算机价格匹配官方退货物流'
        : '谷仓 OpenAPI 运费试算已返回报价，但未匹配到官方退货物流')
      : firstNonEmpty(methods.message, goodcangMessage(response.json, response.error || '谷仓 OpenAPI 运费试算未返回可用物流')),
    rawTextSnippet: safeSnippet({
      returnMethods: methods.response?.json || methods.message,
      deliveryFee: response.json || response.text || response.error
    }, 2500)
  };
}

function inventoryQuantity(item = {}, names = []) {
  for (const name of names) {
    const value = Number(item[name]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeGoodcangInventoryItem(item = {}) {
  const sellable = inventoryQuantity(item, ['sellable', 'available', 'available_qty', 'availableQty']);
  const pending = inventoryQuantity(item, ['pending']);
  const reserved = inventoryQuantity(item, ['reserved']);
  const unsellable = inventoryQuantity(item, ['unsellable']);
  const onway = inventoryQuantity(item, ['onway', 'total_onway', 'totalOnway']);
  const warehouseCode = firstNonEmpty(item.warehouse_code, item.warehouseCode, item.warehouse);
  return {
    platform: 'goodcang',
    sku: firstNonEmpty(item.product_sku, item.productSku, item.sku),
    productBarcode: firstNonEmpty(item.product_barcode, item.productBarcode),
    warehouseCode,
    warehouseName: firstNonEmpty(item.warehouse_desc, item.warehouseDesc, item.warehouse_name, item.warehouseName, warehouseCode),
    sellable,
    pending,
    reserved,
    unsellable,
    onway,
    raw: item
  };
}

async function queryGoodcangInventoryBySkus(skus = []) {
  const productSkus = [...new Set(skus.map(value => String(value || '').trim()).filter(Boolean))];
  if (!productSkus.length) {
    return {
      platform: 'goodcang',
      found: false,
      items: [],
      warehouseCandidates: [],
      message: '谷仓库存查询缺少 SKU'
    };
  }

  const response = await goodcangCall('/inventory/get_product_inventory', {
    page: 1,
    pageSize: Math.max(20, productSkus.length * 20),
    product_sku_arr: productSkus
  });
  const items = dataList(response.json).map(normalizeGoodcangInventoryItem)
    .filter(item => item.warehouseCode && item.sku);
  const byWarehouse = new Map();
  for (const item of items) {
    const current = byWarehouse.get(item.warehouseCode) || {
      warehouseCode: item.warehouseCode,
      warehouseName: item.warehouseName,
      items: [],
      matchedSkuCount: 0,
      sellableTotal: 0
    };
    current.items.push(item);
    current.matchedSkuCount = new Set(current.items.map(row => row.sku)).size;
    current.sellableTotal += item.sellable;
    byWarehouse.set(item.warehouseCode, current);
  }
  const warehouseCandidates = [...byWarehouse.values()]
    .sort((left, right) => {
      if (right.matchedSkuCount !== left.matchedSkuCount) return right.matchedSkuCount - left.matchedSkuCount;
      return right.sellableTotal - left.sellableTotal;
    });
  return {
    platform: 'goodcang',
    found: items.length > 0,
    items,
    warehouseCandidates,
    message: items.length
      ? '谷仓库存接口已返回 SKU 仓库库存'
      : goodcangMessage(response.json, response.error || '谷仓库存接口未返回 SKU 库存'),
    rawTextSnippet: safeSnippet(response.json || response.text || response.error, 2000)
  };
}

function buildReturnPayload(order, selected) {
  const products = normalizeProducts(order);
  const address = normalizeAddress(order);
  const customLogistics = isGoodcangCustomReturnLogistics(order);
  const customerReturnTrackingNo = goodcangCustomerReturnTrackingNo(order);
  const customerReturnCarrierName = goodcangCustomerReturnCarrierName(order);
  return {
    order_code: firstNonEmpty(order.warehouseOrderNo, order.order_code, order.orderCode, order.orderNo),
    ref_no: firstNonEmpty(order.stOrderNo, order.referenceNo, order.rawOrderNo),
    return_identification: 1,
    is_verify: process.env.GOODCANG_CREATE_VERIFY || '1',
    warehouse_code: firstNonEmpty(order.warehouseCode, order.warehouse_code, order.warehouse),
    service_type: 1,
    logistics: customLogistics ? GOODCANG_CUSTOM_LOGISTICS : GOODCANG_PLATFORM_LOGISTICS,
    courier: customLogistics
      ? ''
      : firstNonEmpty(selected?.code, selected?.courier, selected?.name, order.returnCourier, order.courier, order.shippingMethod),
    tracking_no: customLogistics ? customerReturnTrackingNo : '',
    ro_desc: order.returnReason || 'customer return',
    ro_note: order.returnNote || '',
    product_list: products.map(item => ({
      product_sku: item.sku || item.warehouseSku,
      num: Number(item.quantity) || 1
    })),
    delivery_address: {
      name: address.name,
      last_name: address.lastName || '',
      country_code: address.countryCode,
      province: address.state || '',
      city: address.city || '',
      address1: address.address1,
      address2: address.address2 || '',
      company: address.company || '',
      doorplate: '',
      zipcode: address.postcode,
      phone: address.phone,
      email: address.email
    }
  };
}

function validateReturnPayload(payload) {
  const missing = [];
  if (!payload.order_code) missing.push('仓库订单号 order_code');
  if (!payload.warehouse_code) missing.push('退件收货仓库 warehouse_code');
  if (payload.logistics === GOODCANG_PLATFORM_LOGISTICS && !payload.courier) missing.push('可用物流产品 courier');
  if (payload.logistics === GOODCANG_CUSTOM_LOGISTICS && !payload.tracking_no) missing.push('自选退货物流号 tracking_no');
  if (!payload.product_list.length) missing.push('退件 SKU product_list');
  if (!payload.delivery_address.country_code) missing.push('退件地址国家 country_code');
  if (!payload.delivery_address.zipcode) missing.push('退件地址邮编 zipcode');
  return missing;
}

function extractCreateResult(json) {
  const data = gcData(json) || {};
  const objects = collectObjects(data, item =>
    Boolean(
      item.asro_code ||
      item.asroCode ||
      item.return_order_code ||
      item.returnOrderCode ||
      item.return_code ||
      item.returnCode ||
      item.tracking_no ||
      item.trackingNo
    )
  );
  const source = objects[0] || (data && typeof data === 'object' ? data : {});
  return {
    returnOrderNo: firstNonEmpty(
      source.asro_code,
      source.asroCode,
      source.return_order_code,
      source.returnOrderCode,
      source.return_code,
      source.returnCode,
      source.ro_code,
      source.roCode,
      firstDeepValue(source, ['asro_code', 'asroCode', 'return_order_code', 'returnOrderCode', 'return_code', 'returnCode', 'ro_code', 'roCode'])
    ),
    trackingNo: firstNonEmpty(
      source.tracking_no,
      source.trackingNo,
      source.tracking_number,
      source.trackingNumber,
      firstDeepValue(source, ['tracking_no', 'trackingNo', 'tracking_number', 'trackingNumber'])
    ),
    raw: source
  };
}

function goodcangCreateOk(create, createData, customLogistics = false) {
  const hasReturnOrderNo = Boolean(createData?.returnOrderNo);
  if (!create?.ok || !hasReturnOrderNo) return false;
  if (apiSuccess(create.json)) return true;
  return Boolean(customLogistics);
}

function looksLikeBase64(value) {
  const text = String(value || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  return text.length >= 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function extractLabelResult(json) {
  const data = gcData(json) || {};
  const labelBase64 = firstNonEmpty(
    firstDeepValue(data, [
      'label_base64',
      'labelBase64',
      'label_pdf',
      'labelPdf',
      'file_base64',
      'fileBase64',
      'file_content',
      'fileContent',
      'base64',
      'label',
      'file'
    ]),
    typeof data === 'string' && looksLikeBase64(data) ? data : '',
    typeof json === 'string' && looksLikeBase64(json) ? json : ''
  );
  return {
    labelBase64,
    labelType: firstNonEmpty(firstDeepValue(data, ['label_type', 'labelType', 'image_type', 'imageType', 'file_type', 'fileType']), 'pdf'),
    trackingNo: firstNonEmpty(firstDeepValue(data, ['tracking_no', 'trackingNo', 'tracking_number', 'trackingNumber'])),
    labelNo: firstNonEmpty(firstDeepValue(data, ['label_no', 'labelNo', 'waybill_no', 'waybillNo'])),
    raw: data
  };
}

async function getGoodcangLabel(asroCode, orderNo = asroCode) {
  if (!asroCode) return null;
  const response = await goodcangCall('/return_order/label', { asro_code: asroCode });
  const data = extractLabelResult(response.json);
  return {
    response,
    item: data.raw,
    labelFile: data.labelBase64 ? saveBase64Label('goodcang', orderNo, data.labelBase64, data.labelType) : null,
    labelBase64: Boolean(data.labelBase64),
    labelType: data.labelType,
    trackingNo: data.trackingNo,
    labelNo: data.labelNo
  };
}

async function queryGoodcangReturnOrders(filters = {}) {
  const payload = {
    currentPage: String(filters.currentPage || 1),
    pageSize: String(filters.pageSize || 20),
    ...filters
  };
  const response = await goodcangCall('/return_order/list', payload);
  return {
    response,
    list: response.ok && apiSuccess(response.json) ? dataList(response.json) : []
  };
}

function goodcangReturnOrderStatus(item = {}) {
  return firstNonEmpty(
    item.asro_status,
    item.asroStatus,
    item.asro_status_text,
    item.asroStatusText,
    item.status_name,
    item.statusName,
    item.status_text,
    item.statusText,
    item.status
  );
}

function isDiscardedGoodcangReturnOrder(item = {}) {
  const status = compactText(goodcangReturnOrderStatus(item));
  return status === '6' ||
    /废弃|作废|取消|已取消|cancel|cancelled|void|discard|discarded|abandon|abandoned|invalid/i.test(status);
}

async function resolveExistingGoodcangReturnOrder(order = {}) {
  const orderCode = firstNonEmpty(order.warehouseOrderNo, order.order_code, order.orderCode, order.orderNo);
  const referenceNo = firstNonEmpty(order.stOrderNo, order.referenceNo, order.rawOrderNo);
  const queries = [
    order.returnOrderNo ? { asroCodes: order.returnOrderNo } : null,
    referenceNo ? { reference_no: referenceNo } : null,
    { currentPage: '1', pageSize: '100' },
    { currentPage: '2', pageSize: '100' },
    { currentPage: '3', pageSize: '100' }
  ].filter(Boolean);

  for (const query of queries) {
    const result = await queryGoodcangReturnOrders(query);
    const matchedRows = result.list.filter(row =>
      (orderCode && (
        row.order_code === orderCode ||
        asArray(row.order_code_list).includes(orderCode)
      )) ||
      (referenceNo && row.reference_no === referenceNo) ||
      (order.returnOrderNo && row.asro_code === order.returnOrderNo)
    );
    const item = matchedRows.find(row => !isDiscardedGoodcangReturnOrder(row));
    if (item) {
      return {
        response: result.response,
        item,
        returnOrderNo: firstNonEmpty(item.asro_code, item.return_order_code, item.returnOrderCode),
        trackingNo: firstNonEmpty(item.tracking_no, item.trackingNo),
        labelNo: firstNonEmpty(item.tracking_no, item.trackingNo, item.asro_code),
        feeDetails: firstNonEmpty(item.fee_details, item.charge_details),
        status: goodcangReturnOrderStatus(item)
      };
    }
  }
  return null;
}

async function createGoodcangReturnApi({ order, dryRun = true, allowCreate = false, shippingQuote = null } = {}) {
  const customLogistics = isGoodcangCustomReturnLogistics(order);
  const customCandidate = customLogistics ? await resolveGoodcangCustomReturnCandidate(order) : null;
  const manualSelectedLogistics = normalizeManualGoodcangLogistics(order.manualSelectedLogistics || order.manualRetryLogistics);
  const manualOfficialRetry = Boolean(manualSelectedLogistics) && !customLogistics;
  const quote = customLogistics
    ? {
      platform: 'goodcang',
      quoted: false,
      candidates: customCandidate ? [customCandidate] : [],
      returnCandidates: customCandidate ? [customCandidate] : [],
      selected: customCandidate,
      message: '用户已输入退货物流号和物流商，谷仓按自选物流创建，不调用费用计算机。'
    }
    : (shippingQuote?.candidates?.length ? shippingQuote : await calculateGoodcangShippingApi(order));
  const candidates = sortGoodcangCandidates(
    (quote.candidates || []).filter(item => !isExcludedGoodcangLogistics(item))
  );
  const preferredCandidates = sortGoodcangCandidates(
    (quote.returnCandidates || candidates).filter(item => item?.returnService !== false)
      .filter(item => !isExcludedGoodcangLogistics(item))
      .filter(item => item && (item.code || item.name))
  );
  const pricedCandidates = preferredCandidates.filter(hasGoodcangPrice);
  const preferredSelected = hasPreferredGoodcangCourier(order)
    ? chooseGoodcangCourier({ candidates: preferredCandidates }, order)
    : null;
  const manualSelected = manualOfficialRetry
    ? (preferredSelected || manualSelectedLogistics)
    : null;
  const selected = preferredSelected ||
    (hasGoodcangPrice(quote.selected) && !isExcludedGoodcangLogistics(quote.selected)
      ? quote.selected
      : chooseGoodcangCourier({ candidates: pricedCandidates }, order));
  const selectedCandidates = customLogistics
    ? [customCandidate].filter(Boolean)
    : (manualOfficialRetry
      ? [manualSelected].filter(Boolean)
      : uniqueGoodcangSelection([
        preferredSelected,
        ...pricedCandidates
      ]));
  const selectedLogistics = selectedCandidates[0] || selected || customCandidate;
  const payload = buildReturnPayload(order, selectedLogistics);
  const result = {
    platform: 'goodcang',
    mode: 'api',
    dryRun,
    created: false,
    returnLogisticsMode: customLogistics ? 'custom' : 'auto',
    returnTrackingProvided: Boolean(goodcangCustomerReturnTrackingNo(order)),
    selectionStrategy: customLogistics
      ? 'input-custom-logistics'
      : (manualOfficialRetry ? 'manual-selected-official-logistics' : 'fee-calculator-official-intersection'),
    shippingQuote: quote,
    manualSelectedLogistics: manualSelectedLogistics || null,
    selectedLogistics,
    logisticsCandidates: (customLogistics ? selectedCandidates : preferredCandidates).slice(0, 8),
    attemptedLogistics: [],
    createPayloadPreview: {
      ...payload,
      delivery_address: {
        ...payload.delivery_address,
        phone: payload.delivery_address.phone ? '***' : '',
        email: payload.delivery_address.email ? '***' : ''
      }
    }
  };

  if (!customLogistics && !selectedCandidates.length) {
    return {
      ...result,
      needsReview: true,
      message: '谷仓 API 费用计算机没有可信匹配到官方退货物流价格，待报价渠道不参与最低价选择'
    };
  }

  const missing = validateReturnPayload(payload);
  if (missing.length) {
    return {
      ...result,
      needsReview: true,
      message: `谷仓 API 创建缺少：${fieldList(missing)}`
    };
  }
  if (!customLogistics && !selectedLogistics?.code && !selectedLogistics?.name && !payload.courier) {
    return {
      ...result,
      needsReview: true,
      message: quote.message || '谷仓 API 创建前没有可用物流报价'
    };
  }
  if (!allowCreate || dryRun) {
    return {
      ...result,
      message: customLogistics
        ? 'Dry-run: 谷仓 API 已完成查单和自选物流创建参数校验，未调用创建接口。'
        : 'Dry-run: 谷仓 API 已完成查单、官方退货物流选择和创建参数校验，未调用创建接口。'
    };
  }

  const existingBeforeCreate = await resolveExistingGoodcangReturnOrder(order);
  if (existingBeforeCreate?.returnOrderNo) {
    const label = customLogistics
      ? null
      : await getGoodcangLabel(existingBeforeCreate.returnOrderNo, existingBeforeCreate.returnOrderNo);
    return {
      ...result,
      created: true,
      reusedExisting: true,
      returnOrderNo: existingBeforeCreate.returnOrderNo,
      trackingNo: firstNonEmpty(
        existingBeforeCreate.trackingNo,
        label?.trackingNo,
        customLogistics ? goodcangCustomerReturnTrackingNo(order) : ''
      ),
      labelNo: firstNonEmpty(label?.labelNo, existingBeforeCreate.labelNo, existingBeforeCreate.returnOrderNo),
      feeDetails: existingBeforeCreate.feeDetails,
      status: existingBeforeCreate.status,
      labelFile: label?.labelFile || null,
      labelDownloadUrl: label?.labelFile?.downloadUrl || '',
      labelBase64: label?.labelBase64 || false,
      downloaded: Boolean(label?.labelFile),
      message: customLogistics
        ? '谷仓 API 已找到既有退货单；本单为自选物流，无需下载预约面单。'
        : (label?.labelFile
          ? '谷仓 API 已找到既有退货单并保存面单文件。'
          : '谷仓 API 已找到既有退货单，但面单接口未返回文件。'),
      labelResponse: label?.response
        ? {
          status: label.response.status,
          ok: label.response.ok,
          message: goodcangMessage(label.response.json, label.response.error || 'return_order/label 未返回 label_base64')
        }
        : null
    };
  }

  let lastCreate = null;
  let lastPayload = payload;
  let lastCreateData = {};
  let lastReturnOrderNo = '';
  let lastTrackingNo = '';
  for (const candidate of selectedCandidates) {
    const attemptPayload = buildReturnPayload(order, candidate);
    const create = await goodcangCall('/return_order/create', attemptPayload);
    const createData = extractCreateResult(create.json);
    const returnOrderNo = createData.returnOrderNo;
    const trackingNo = firstNonEmpty(createData.trackingNo, customLogistics ? goodcangCustomerReturnTrackingNo(order) : '');
    const created = goodcangCreateOk(create, createData, customLogistics);
    const attempt = {
      code: candidate?.code || attemptPayload.courier,
      name: candidate?.name || candidate?.code || attemptPayload.courier,
      price: candidate?.price ?? null,
      currency: candidate?.currency || '',
      ok: created || (create.ok && apiSuccess(create.json)),
      created,
      message: goodcangMessage(create.json, create.error || '')
    };
    result.attemptedLogistics.push(attempt);
    lastCreate = create;
    lastPayload = attemptPayload;
    lastCreateData = createData;
    result.createResponse = {
      status: create.status,
      ok: create.ok,
      message: attempt.message
    };
    result.selectedLogistics = candidate;
    result.created = attempt.created;
    result.returnOrderNo = returnOrderNo;
    result.trackingNo = trackingNo;
    result.labelNo = trackingNo || returnOrderNo;
    lastReturnOrderNo = returnOrderNo;
    lastTrackingNo = trackingNo;
    if (result.created) break;
    const retryable = /物流|logistics|courier|verification|verify|product|渠道|服务|不可用|不支持|not support|invalid|psc|billing|exception|尺寸|长宽高|超长|超重|size|dimension/i.test(attempt.message);
    if (!retryable) break;
  }

  if (!result.created) {
    const create = lastCreate || {};
    const returnOrderNo = lastReturnOrderNo || lastCreateData.returnOrderNo;
    const trackingNo = lastTrackingNo || lastCreateData.trackingNo;
    if (customLogistics && returnOrderNo) {
      result.created = true;
      result.returnOrderNo = returnOrderNo;
      result.trackingNo = firstNonEmpty(trackingNo, goodcangCustomerReturnTrackingNo(order));
      result.labelNo = firstNonEmpty(result.trackingNo, returnOrderNo);
      result.labelFile = null;
      result.labelDownloadUrl = '';
      result.labelBase64 = false;
      result.downloaded = false;
      result.message = '谷仓 API 已按自选物流创建退货单；平台不生成预约退货面单文件。';
      result.labelInfo = null;
      return result;
    }
    const createMessage = create.ok && apiSuccess(create.json) && !returnOrderNo
      ? '谷仓 API 创建成功响应缺少退货单号 asro_code/return_order_code'
      : goodcangMessage(create.json, create.error || '谷仓 API 创建退货单失败');
    const alreadyCreated = /已存在|重复|已经创建|已创建|可退|数量不足|exceeds the quantity|quantity of goods|already/i.test(createMessage);
    if (alreadyCreated) {
      const existing = await resolveExistingGoodcangReturnOrder({
        ...order,
        returnOrderNo,
        warehouseOrderNo: lastPayload.order_code,
        referenceNo: lastPayload.ref_no
      });
      if (existing?.returnOrderNo) {
        const label = customLogistics
          ? null
          : await getGoodcangLabel(existing.returnOrderNo, existing.returnOrderNo);
        result.created = true;
        result.returnOrderNo = existing.returnOrderNo;
        result.trackingNo = firstNonEmpty(existing.trackingNo, label?.trackingNo, trackingNo, customLogistics ? goodcangCustomerReturnTrackingNo(order) : '');
        result.labelNo = firstNonEmpty(label?.labelNo, existing.labelNo, result.trackingNo, existing.returnOrderNo);
        result.feeDetails = existing.feeDetails;
        result.status = existing.status;
        result.labelFile = label?.labelFile || null;
        result.labelDownloadUrl = label?.labelFile?.downloadUrl || '';
        result.labelBase64 = label?.labelBase64 || false;
        result.downloaded = Boolean(label?.labelFile);
        result.message = customLogistics
          ? '谷仓 API 已找到既有退货单；本单为自选物流，无需下载预约面单。'
          : (result.downloaded
            ? '谷仓 API 已找到既有退货单并保存面单文件。'
            : '谷仓 API 已找到既有退货单，但面单接口未返回文件。');
        if (!customLogistics && !result.downloaded) result.needsReview = true;
        result.labelResponse = label?.response
          ? {
            status: label.response.status,
            ok: label.response.ok,
            message: goodcangMessage(label.response.json, label.response.error || 'return_order/label 未返回 label_base64')
          }
          : null;
        return result;
      }
    }
    result.needsReview = true;
    result.message = createMessage;
    result.rawTextSnippet = safeSnippet(create.json || create.text || create.error, 3000);
    return result;
  }

  if (customLogistics) {
    result.trackingNo = firstNonEmpty(result.trackingNo, goodcangCustomerReturnTrackingNo(order));
    result.labelNo = firstNonEmpty(result.labelNo, result.returnOrderNo);
    result.labelFile = null;
    result.labelDownloadUrl = '';
    result.labelBase64 = false;
    result.downloaded = false;
    result.message = '谷仓 API 已按自选物流创建退货单；平台不生成预约退货面单文件。';
    result.labelInfo = null;
    return result;
  }

  const label = await getGoodcangLabel(lastReturnOrderNo, lastReturnOrderNo);
  result.trackingNo = firstNonEmpty(result.trackingNo, label?.trackingNo);
  result.labelNo = firstNonEmpty(label?.labelNo, result.trackingNo, lastReturnOrderNo);
  result.labelFile = label?.labelFile || null;
  result.labelDownloadUrl = label?.labelFile?.downloadUrl || '';
  result.labelBase64 = label?.labelBase64 || false;
  result.downloaded = Boolean(label?.labelFile);
  result.message = result.downloaded
    ? '谷仓 API 已创建退货单并保存面单文件。'
    : '谷仓 API 已创建退货单，但面单接口未返回文件。';
  if (!result.downloaded) result.needsReview = true;
  result.labelResponse = label?.response
    ? {
      status: label.response.status,
      ok: label.response.ok,
      message: goodcangMessage(label.response.json, label.response.error || 'return_order/label 未返回 label_base64')
    }
    : null;
  result.labelInfo = label
    ? {
      trackingNo: label.trackingNo || '',
      labelNo: label.labelNo || '',
      labelType: label.labelType || '',
      labelFile: label.labelFile || null
    }
    : null;
  return result;
}

async function finalizeGoodcangReturnsApi({ returnOrderNos } = {}) {
  return {
    platform: 'goodcang',
    mode: 'api',
    submitted: true,
    downloaded: true,
    returnOrderNos: returnOrderNos || [],
    message: '谷仓 API 模式创建时已直接审核并拉取面单，无需网页登录批量提交。'
  };
}

async function probeGoodcangApi() {
  try {
    requireConfig();
    const response = await goodcangCall('/base_data/get_warehouse', {});
    return {
      platform: 'goodcang',
      ok: response.ok && apiSuccess(response.json),
      mode: 'api',
      status: response.status,
      message: apiMessage(response.json, response.error || '谷仓 API 已响应'),
      rawTextSnippet: safeSnippet(response.json || response.text, 1000)
    };
  } catch (error) {
    return {
      platform: 'goodcang',
      ok: false,
      mode: 'api',
      error: error.message,
      message: `谷仓 API 检查失败：${error.message}`
    };
  }
}

module.exports = {
  calculateGoodcangShippingApi,
  createGoodcangReturnApi,
  finalizeGoodcangReturnsApi,
  findGoodcangOrderApi,
  getGoodcangLabel,
  goodcangCall,
  normalizeGoodcangOrder,
  probeGoodcangApi,
  queryGoodcangInventoryBySkus,
  _internal: {
    isExcludedGoodcangLogistics,
    rankGoodcangReturnCandidatesByFee,
    scoreGoodcangPriceMatch
  }
};
