const { config } = require('../env');
const {
  apiMessage,
  apiSuccess,
  asArray,
  chooseCheapest,
  collectObjects,
  compactText,
  fetchJson,
  firstNonEmpty,
  md5,
  numericAmount,
  safeSnippet,
  saveBase64Label,
  stableStringify
} = require('./common');

function requireConfig({ requireClient = false } = {}) {
  const missing = [];
  if (!config.api.winit.token) missing.push('WINIT_TOKEN');
  if (!config.api.winit.appKey) missing.push('WINIT_APP_KEY');
  if (requireClient && !config.api.winit.clientId) missing.push('WINIT_CLIENT_ID');
  if (requireClient && !config.api.winit.clientSecret) missing.push('WINIT_CLIENT_SECRET');
  if (missing.length) {
    throw new Error(`万邑通 API 缺少配置：${missing.join(', ')}`);
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    '-',
    pad(now.getMonth() + 1),
    '-',
    pad(now.getDate()),
    ' ',
    pad(now.getHours()),
    ':',
    pad(now.getMinutes()),
    ':',
    pad(now.getSeconds())
  ].join('');
}

function sortedParamString(params) {
  return Object.keys(params)
    .filter(key =>
      key !== 'sign' &&
      key !== 'client_sign' &&
      key !== 'language' &&
      params[key] !== undefined &&
      params[key] !== null
    )
    .sort()
    .map(key => {
      const value = key === 'data'
        ? stableStringify(params[key])
        : String(params[key]);
      return `${key}${value}`;
    })
    .join('');
}

function signWinit(params, secret) {
  return md5(`${secret}${sortedParamString(params)}${secret}`).toUpperCase();
}

function buildRequest(action, data = {}) {
  requireConfig();
  const params = {
    action,
    app_key: config.api.winit.appKey,
    data: data || {},
    format: 'json',
    language: 'zh_CN',
    platform: config.api.winit.platform || 'OWNERERP',
    sign_method: 'md5',
    timestamp: timestamp(),
    version: '1.0'
  };
  if (config.api.winit.clientId) params.client_id = config.api.winit.clientId;
  params.sign = signWinit(params, config.api.winit.token);
  if (config.api.winit.clientSecret) {
    params.client_sign = signWinit(params, config.api.winit.clientSecret);
  }
  return params;
}

async function winitCall(action, data = {}) {
  const body = buildRequest(action, data);
  const response = await fetchJson(config.api.winit.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    timeoutMs: 35000
  });
  return {
    action,
    data,
    ok: response.ok,
    status: response.status,
    json: response.json,
    text: response.text,
    error: response.error
  };
}

function winitSuccess(json) {
  if (!json || typeof json !== 'object') return false;
  if (apiSuccess(json)) return true;
  const code = firstNonEmpty(json.code, json.errorCode, json.returnCode);
  return /^(0|200|success)$/i.test(String(code));
}

function winitMessage(json, fallback = '') {
  return firstNonEmpty(
    json?.msg,
    json?.message,
    json?.errorMsg,
    json?.error_msg,
    json?.error?.message,
    fallback
  );
}

function dataOf(json) {
  return json?.data ?? json?.result ?? json;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dateOnly(date);
}

const COUNTRY_NAME_TO_CODE = {
  澳大利亚: 'AU',
  Australia: 'AU',
  美国: 'US',
  'United States': 'US',
  英国: 'GB',
  'United Kingdom': 'GB',
  德国: 'DE',
  Germany: 'DE',
  法国: 'FR',
  France: 'FR',
  意大利: 'IT',
  Italy: 'IT',
  西班牙: 'ES',
  Spain: 'ES',
  加拿大: 'CA',
  Canada: 'CA',
  日本: 'JP',
  Japan: 'JP'
};

function countryCodeFromName(value) {
  const text = compactText(value);
  if (!text) return '';
  return COUNTRY_NAME_TO_CODE[text] || COUNTRY_NAME_TO_CODE[text.toLowerCase()] || '';
}

function isLikelyWinitServiceCode(value) {
  return /^OSF\d+/i.test(String(value || ''));
}

function normalizeProductItem(item = {}) {
  const sku = firstNonEmpty(
    item.productCode,
    item.product_code,
    item.productSku,
    item.product_sku,
    item.sku,
    item.merchandiseCode
  );
  if (!sku || isLikelyWinitServiceCode(sku)) return null;
  const quantity = Number(firstNonEmpty(
    item.productNum,
    item.actualDispatchQty,
    item.outboundQuantity,
    item.product_num,
    item.quantity,
    item.qty,
    item.num,
    item.merchandiseNum,
    1
  )) || 1;
  return {
    sku,
    warehouseSku: firstNonEmpty(item.warehouseSku, item.merchandiseCode, sku),
    productCode: sku,
    quantity,
    specification: firstNonEmpty(item.specification, item.productSpecification)
  };
}

function normalizeProducts(value = {}) {
  const source = value.raw || value;
  const direct = normalizeProductItem(source);
  const packageProducts = asArray(source.packageList)
    .flatMap(pkg => asArray(pkg.merchandiseList))
    .map(normalizeProductItem)
    .filter(Boolean);
  const containerProducts = asArray(source.packageList)
    .flatMap(pkg => asArray(pkg.orderContainerList))
    .flatMap(container => asArray(container.merchandiseList))
    .map(normalizeProductItem)
    .filter(Boolean);
  const collected = collectObjects(source, item =>
    Boolean(item.productCode || item.product_code || item.productSku || item.product_sku || item.merchandiseCode)
  ).map(normalizeProductItem).filter(Boolean);
  const products = [
    direct,
    ...packageProducts,
    ...containerProducts,
    ...collected
  ].filter(Boolean);
  const fallbackSku = firstNonEmpty(value.productCode, value.sku, value.primarySku, value.warehouseSku);
  if (!products.length && fallbackSku && !isLikelyWinitServiceCode(fallbackSku)) {
    products.push({ sku: fallbackSku, warehouseSku: fallbackSku, productCode: fallbackSku, quantity: Number(value.quantity) || 1 });
  }
  const seen = new Set();
  return products.filter(item => {
    const key = `${item.productCode}|${item.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAddress(value = {}) {
  const address = value.address || {};
  const countryCode = firstNonEmpty(
    address.countryCode,
    address.country,
    value.countryCode,
    value.country,
    /^[A-Z]{2}$/i.test(String(value.state || '')) ? value.state : '',
    countryCodeFromName(value.countryName)
  );
  return {
    name: firstNonEmpty(address.name, value.recipientName, value.name, value.receiverName, value.consigneeName, value.buyerName, 'customer'),
    email: firstNonEmpty(address.email, value.emailAddress, value.email, 'return@example.com'),
    phone: firstNonEmpty(address.phone, value.phoneNum, value.phone, value.receiverPhone, '0000000000'),
    countryCode: String(countryCode).toUpperCase(),
    state: firstNonEmpty(address.state, value.regionName, /^[A-Z]{2}$/i.test(String(value.state || '')) ? '' : value.state, value.receiverState),
    city: firstNonEmpty(address.city, value.city, value.receiverCity),
    postcode: firstNonEmpty(address.postcode, address.zipCode, address.zipcode, value.postcode, value.zipCode, value.postal),
    houseNo: firstNonEmpty(address.houseNo, address.doorplate, value.doorplateNumbers),
    address1: firstNonEmpty(address.address1, address.street1, value.address1, 'unknown'),
    address2: firstNonEmpty(address.address2, address.street2, value.address2)
  };
}

function normalizeOutboundRecord(record = {}, trackingNo = '') {
  const packageList = asArray(record.packageList);
  const packageTracking = packageList.flatMap(item => asArray(item.trackingNos || item.trackingNoList || item.trackingNo));
  const products = normalizeProducts(record);
  const warehouseCode = firstNonEmpty(
    record.warehouseCode,
    record.warehouseID,
    record.warehouseId,
    record.packageList?.[0]?.warehouseCode,
    record.actualWarehouseInfoList?.[0]?.warehouseCode
  );
  const warehouseOrderNo = firstNonEmpty(record.documentNo, record.outboundOrderNum, record.orderNo, record.outboundOrderNo);
  return {
    platform: 'winit',
    source: 'winit-api',
    found: Boolean(warehouseOrderNo),
    warehouseOrderNo,
    warehouseOrderCandidates: [warehouseOrderNo].filter(Boolean),
    warehouse: firstNonEmpty(record.warehouseName, record.warehouse_name, record.actualWarehouseInfoList?.[0]?.warehouseName, warehouseCode),
    warehouseCode,
    trackingNo: firstNonEmpty(trackingNo, record.trackingNo, record.trackingNum, record.winitTrackingNo, packageTracking[0]),
    trackingNumbers: [...new Set([
      trackingNo,
      record.trackingNo,
      record.trackingNum,
      record.winitTrackingNo,
      ...packageTracking
    ].filter(Boolean))],
    sellerOrderNo: firstNonEmpty(record.sellerOrderNo, record.customerOrderNo, record.referenceNo),
    customerOrderNo: firstNonEmpty(record.sellerOrderNo, record.customerOrderNo, record.referenceNo),
    shippingNo: firstNonEmpty(record.shippingNo, record.packageNo, packageList[0]?.packageNum, packageList[0]?.packageNo),
    storeType: firstNonEmpty(record.storeType, record.orderStoreType, record.platform, 'Temu'),
    deliveryWayName: firstNonEmpty(record.deliverywayName, record.deliveryWayName),
    products,
    primarySku: products[0]?.productCode || products[0]?.sku || '',
    quantity: products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1,
    address: normalizeAddress(record),
    raw: record,
    rawTextSnippet: safeSnippet(record, 4000)
  };
}

function extractOutboundList(json) {
  const data = dataOf(json) || {};
  return asArray(data.list || data.data || data.rows || data);
}

function normalizeFlag(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).trim().toUpperCase();
}

function isYesFlag(value) {
  if (value === true) return true;
  return ['Y', 'YES', 'TRUE', '1', '是'].includes(normalizeFlag(value));
}

function isNoFlag(value) {
  if (value === false) return true;
  return ['N', 'NO', 'FALSE', '0', '否'].includes(normalizeFlag(value));
}

function returnLabelFlag(item = {}) {
  return firstNonEmpty(
    item.deliveryService,
    item.isReturnLabel,
    item.returnLabel,
    item.return_label,
    item.returnLabelSupported,
    item.supportReturnLabel,
    item.support_return_label,
    item.supportReturnService,
    item.support_return_service,
    item.hasReturnLabel
  );
}

function supportsReturnLabel(item = {}, { trustedPsc = false } = {}) {
  const flag = returnLabelFlag(item);
  if (flag !== '') {
    if (isNoFlag(flag)) return false;
    if (isYesFlag(flag)) return true;
  }
  const markerText = compactText(JSON.stringify({
    serviceType: item.serviceType,
    serviceName: item.serviceName,
    productName: item.productName,
    winitProductName: item.winitProductName,
    deliveryWayName: item.deliveryWayName,
    name: item.name
  }));
  if (/return\s*label|退货面单|回邮面单/i.test(markerText)) return true;
  return trustedPsc && Boolean(firstNonEmpty(item.productCode, item.winitProductCode, item.code, item.productName));
}

function sortCandidatesByPrice(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftPrice = Number(left.price);
    const rightPrice = Number(right.price);
    const leftHasPrice = Number.isFinite(leftPrice);
    const rightHasPrice = Number.isFinite(rightPrice);
    if (leftHasPrice && rightHasPrice) return leftPrice - rightPrice;
    if (leftHasPrice) return -1;
    if (rightHasPrice) return 1;
    return 0;
  });
}

function selectReturnLabelCandidate(candidates = []) {
  const supported = sortCandidatesByPrice(candidates.filter(item => item?.returnLabelSupported !== false));
  return chooseCheapest(supported) || supported[0] || null;
}

function winitCustomerReturnTrackingNo(order = {}) {
  return firstNonEmpty(
    order.customerReturnTrackingNo,
    order.returnExpressNo,
    order.expressNo,
    order.returnTrackingNo
  );
}

function winitCustomerReturnCarrierName(order = {}) {
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

function isWinitCustomReturnLogistics(order = {}) {
  const explicit = String(firstNonEmpty(order.returnLogisticsMode, order.logisticsMode)).trim().toLowerCase();
  if (['custom', 'self', 'manual', '自选', '自寄'].includes(explicit)) return true;
  if (['auto', 'platform', 'official', '平台', '官方', '代选'].includes(explicit)) return false;
  return Boolean(winitCustomerReturnTrackingNo(order) || winitCustomerReturnCarrierName(order));
}

function customWinitReturnCandidate(order = {}) {
  const carrierName = winitCustomerReturnCarrierName(order);
  const trackingNo = winitCustomerReturnTrackingNo(order);
  if (!carrierName && !trackingNo) return null;
  return {
    platform: 'winit',
    code: carrierName,
    name: carrierName || '客户自选物流',
    price: null,
    currency: '',
    selected: true,
    source: 'input-custom-logistics',
    customerReturnTrackingNo: trackingNo
  };
}

function sameLogisticsCandidate(left = {}, right = {}) {
  const leftCode = compactText(firstNonEmpty(left.code, left.raw?.productCode, left.raw?.winitProductCode)).toUpperCase();
  const rightCode = compactText(firstNonEmpty(right.code, right.raw?.productCode, right.raw?.winitProductCode)).toUpperCase();
  if (leftCode && rightCode && leftCode === rightCode) return true;
  const leftName = compactText(firstNonEmpty(left.name, left.raw?.productName, left.raw?.winitProductName)).toUpperCase();
  const rightName = compactText(firstNonEmpty(right.name, right.raw?.productName, right.raw?.winitProductName)).toUpperCase();
  return Boolean(leftName && rightName && (leftName.includes(rightName) || rightName.includes(leftName)));
}

async function queryOutboundListByTracking(trackingNo) {
  const payload = {
    trackingNo,
    dateOrderedStartDate: daysAgo(240),
    dateOrderedEndDate: dateOnly(new Date()),
    status: 'ALL',
    pageSize: 20,
    pageNum: 1
  };
  const response = await winitCall('queryOutboundOrderList', payload);
  return response;
}

async function queryOutboundDetail(outboundOrderNum) {
  if (!outboundOrderNum) return null;
  return winitCall('queryOutboundOrder', { outboundOrderNum });
}

async function findWinitOrderApi({ trackingNo, warehouseOrderNo } = {}) {
  if (warehouseOrderNo) {
    const detail = await queryOutboundDetail(warehouseOrderNo);
    if (detail?.ok && winitSuccess(detail.json)) {
      const list = extractOutboundList(detail.json);
      const record = list[0] || dataOf(detail.json);
      const parsed = normalizeOutboundRecord(record, trackingNo);
      if (parsed.found) return parsed;
    }
  }
  if (!trackingNo) {
    return {
      platform: 'winit',
      found: false,
      source: 'winit-api',
      message: '缺少易仓跟踪号，跳过万邑通 API 查询'
    };
  }
  let response;
  try {
    response = await queryOutboundListByTracking(trackingNo);
  } catch (error) {
    return {
      platform: 'winit',
      found: false,
      source: 'winit-api',
      trackingNo,
      message: error.message
    };
  }
  if (!response.ok || !winitSuccess(response.json)) {
    return {
      platform: 'winit',
      found: false,
      source: 'winit-api',
      trackingNo,
      message: winitMessage(response.json, response.error || '万邑通 API 出库列表查询失败'),
      rawTextSnippet: safeSnippet(response.json || response.text || response.error, 2500)
    };
  }
  const records = extractOutboundList(response.json);
  const record = records.find(item => compactText(JSON.stringify(item)).toUpperCase().includes(String(trackingNo).toUpperCase())) || records[0];
  if (!record) {
    return {
      platform: 'winit',
      found: false,
      source: 'winit-api',
      trackingNo,
      message: '万邑通 API 未通过跟踪号匹配到出库单',
      rawTextSnippet: safeSnippet(response.json, 2500)
    };
  }
  const parsed = normalizeOutboundRecord(record, trackingNo);
  if (parsed.warehouseOrderNo) {
    const detail = await queryOutboundDetail(parsed.warehouseOrderNo).catch(() => null);
    if (detail?.ok && winitSuccess(detail.json)) {
      const detailRecord = extractOutboundList(detail.json)[0] || dataOf(detail.json);
      return {
        ...parsed,
        ...normalizeOutboundRecord({ ...record, ...detailRecord }, trackingNo),
        listRawTextSnippet: parsed.rawTextSnippet
      };
    }
  }
  return parsed;
}

function normalizePscCandidate(item = {}) {
  return {
    platform: 'winit',
    code: firstNonEmpty(item.productCode, item.winitProductCode, item.code),
    name: firstNonEmpty(item.productName, item.winitProductName, item.deliveryServiceName, item.name, item.productCode),
    price: numericAmount(item.totalFeeUSD, item.totalFee, item.amount, item.price),
    currency: firstNonEmpty(item.ISOCode, item.currency, 'USD'),
    returnLabelSupported: supportsReturnLabel(item, { trustedPsc: true }),
    deliveryService: firstNonEmpty(returnLabelFlag(item), supportsReturnLabel(item, { trustedPsc: true }) ? 'Y' : ''),
    raw: item
  };
}

async function queryPscList() {
  const response = await winitCall('rma.returnGoodsOrder.queryPSCList', {});
  const list = collectObjects(dataOf(response.json), item =>
    Boolean(item.productCode || item.winitProductCode || item.productName)
  ).map(normalizePscCandidate);
  return {
    response,
    candidates: list.filter(item => item.code || item.name)
  };
}

function normalizeFeeCandidate(item = {}) {
  return {
    platform: 'winit',
    code: firstNonEmpty(item.deliveryWayCode, item.winitProductCode, item.productCode, item.code),
    name: firstNonEmpty(item.deliveryWay, item.deliveryWayName, item.productName, item.name, item.deliveryWayCode),
    price: numericAmount(item.totalFeeUSD, item.totalFee, item.totalAmount, item.amount, item.price),
    currency: firstNonEmpty(item.ISOCode, item.currency, 'USD'),
    returnLabelSupported: supportsReturnLabel(item),
    deliveryService: firstNonEmpty(returnLabelFlag(item), supportsReturnLabel(item) ? 'Y' : ''),
    raw: item
  };
}

async function calculateWinitShippingApi(order = {}) {
  const products = normalizeProducts(order);
  const address = normalizeAddress(order);
  const warehouseCode = firstNonEmpty(order.warehouseCode, order.warehouse_code, order.warehouse);
  const baseResult = {
    platform: 'winit',
    quoted: false,
    candidates: [],
    selected: null
  };
  if (!warehouseCode || !address.countryCode || !address.postcode) {
    return {
      ...baseResult,
      message: '万邑通 OpenAPI 试算缺少仓库、国家或邮编',
      input: { warehouseCode, address, products }
    };
  }
  const payload = {
    warehouseCode,
    country: address.countryCode,
    region: address.state || '',
    city: address.city || '',
    zipCode: address.postcode,
    isResidentialAddress: 'N',
    storeType: order.storeType || 'Temu',
    winitProductCategory4: 'OSF811',
    productList: products.length
      ? products.map(item => ({
        productCode: item.productCode || item.warehouseSku || item.sku,
        productNum: Number(item.quantity) || 1,
        specification: item.specification || ''
      }))
      : [{ length: 10, width: 10, height: 2, weight: 0.2, productNum: 1 }]
  };
  const fee = await winitCall('wh.outbound.calcDeliveryFee', payload).catch(error => ({ error: error.message }));
  const feeList = collectObjects(dataOf(fee.json), item =>
    Boolean(item.deliveryWayCode || item.deliveryWay || item.winitProductCode || item.productCode)
  ).map(normalizeFeeCandidate).filter(item => item.code || item.name);
  const psc = await queryPscList().catch(error => ({ error, candidates: [] }));
  const pscList = psc.candidates || [];
  const merged = pscList.map(pscItem => {
    const feeMatch = feeList.find(item => sameLogisticsCandidate(item, pscItem));
    return {
      ...pscItem,
      price: feeMatch?.price ?? pscItem.price,
      currency: feeMatch?.currency || pscItem.currency,
      returnLabelSupported: pscItem.returnLabelSupported,
      deliveryService: pscItem.deliveryService,
      fee: feeMatch || null
    };
  });
  const feeOnlyList = feeList
    .filter(item => !merged.some(mergedItem => sameLogisticsCandidate(item, mergedItem)));
  const candidates = sortCandidatesByPrice([...merged, ...feeOnlyList]);
  return {
    ...baseResult,
    quoted: candidates.length > 0,
    payload,
    candidates,
    selected: selectReturnLabelCandidate(candidates),
    pscCandidates: pscList.slice(0, 20),
    feeCandidates: feeList.slice(0, 20),
    message: candidates.length
      ? '万邑通 OpenAPI 已返回物流/试算候选'
      : winitMessage(psc.response?.json || fee.json, fee.error || psc.error?.message || '万邑通 OpenAPI 未返回可用物流'),
    rawTextSnippet: safeSnippet({ fee: fee.json || fee.text || fee.error, psc: psc.response?.json }, 2500)
  };
}

function buildReturnGoodsPayload(order, selected) {
  const products = normalizeProducts(order);
  const address = normalizeAddress(order);
  const returnTrackingNo = winitCustomerReturnTrackingNo(order);
  const returnCarrierName = winitCustomerReturnCarrierName(order);
  return {
    customerOrderNo: firstNonEmpty(order.customerOrderNo, order.sellerOrderNo, order.stOrderNo),
    isWinitOutbound: 'Y',
    outboundOrderNo: order.warehouseOrderNo || order.outboundOrderNo || '',
    shippingNo: firstNonEmpty(order.shippingNo, order.packageNo),
    isReturnLabel: 'N',
    expressNo: returnTrackingNo,
    supplierName: returnCarrierName,
    warehouseCode: firstNonEmpty(order.warehouseCode, order.warehouse_code, order.warehouse),
    userInfoSource: 'ORI',
    name: address.name,
    email: address.email,
    phone: address.phone,
    country: address.countryCode,
    state: address.state || '',
    city: address.city || '',
    postcode: address.postcode,
    houseNo: address.houseNo || '',
    address1: address.address1,
    address2: address.address2 || '',
    ReturnGoodsList: products.map(item => ({
      productCode: item.productCode || item.warehouseSku || item.sku,
      productNum: Number(item.quantity) || 1,
      specification: item.specification || '',
      handleMethod: 'SA',
      shelveMethod: 'GOOD_SA'
    }))
  };
}

async function queryReturnLabel(returnGoodsOrderNo) {
  if (!returnGoodsOrderNo) return null;
  const response = await winitCall('rma.returnGoodsOrder.queryReturnLabel', {
    returnGoodsOrderNos: [returnGoodsOrderNo]
  });
  const data = dataOf(response.json);
  const items = Array.isArray(data) ? data : asArray(data?.list || data?.data || data);
  const item = items.find(row => firstNonEmpty(
    row.returnGoodsOrderNo,
    row.returnGoodsOrderNum,
    row.return_order_no,
    row.orderNo
  ) === returnGoodsOrderNo) || items[0] || {};
  const labelBase64 = firstNonEmpty(
    item.label,
    item.labelBase64,
    item.label_base64,
    item.file,
    item.fileBase64,
    item.labelContent
  );
  const trackingNo = firstNonEmpty(
    item.trackingNo,
    item.tracking_no,
    item.trackNo,
    item.waybillNo,
    item.shippingNo,
    item.labelNo
  );
  const labelNo = firstNonEmpty(
    item.labelNo,
    item.label_no,
    item.waybillNo,
    item.trackingNo,
    item.tracking_no
  );
  const labelType = firstNonEmpty(item.labelType, item.label_type, item.fileType, item.file_type, item.type, 'pdf');
  return {
    response,
    item,
    trackingNo,
    labelNo,
    labelFile: labelBase64 ? saveBase64Label('winit', labelNo || trackingNo || returnGoodsOrderNo, labelBase64, labelType) : null,
    labelBase64: Boolean(labelBase64),
    labelType
  };
}

async function queryReturnOrderList(filters = {}) {
  const response = await winitCall('rma.returnGoodsOrder.queryReturnOderList', {
    ...filters,
    pageParams: { pageSize: 20, pageNo: 1 }
  });
  const data = dataOf(response.json);
  const list = Array.isArray(data?.list) ? data.list : asArray(data?.list || data);
  return {
    response,
    list
  };
}

async function resolveExistingReturnOrder(order) {
  const filters = {
    outboundOrderNo: firstNonEmpty(order.outboundOrderNo, order.warehouseOrderNo),
    customerOrderNo: firstNonEmpty(order.customerOrderNo, order.sellerOrderNo, order.stOrderNo),
    rmaNo: firstNonEmpty(order.rmaNo, order.returnRmaNo)
  };
  const response = await queryReturnOrderList(filters);
  const item = response.list.find(row =>
    firstNonEmpty(row.outboundOrderNo, row.customerOrderNo, row.sellerOrderNo) &&
    (
      firstNonEmpty(row.outboundOrderNo, row.customerOrderNo, row.sellerOrderNo) === filters.outboundOrderNo ||
      firstNonEmpty(row.sellerOrderNo, row.customerOrderNo) === filters.customerOrderNo ||
      firstNonEmpty(row.rmaNo) === filters.rmaNo
    )
  ) || response.list[0] || null;
  if (!item) return null;
  return {
    response: response.response,
    item,
    returnOrderNo: firstNonEmpty(item.returnGoodsOrderNo, item.return_order_no, item.orderNo),
    rmaNo: firstNonEmpty(item.rmaNo, item.rma_no),
    trackingNo: firstNonEmpty(item.customerExpressNo, item.expressNo, item.trackingNo, item.tracking_no, item.labelNo, item.returnGoodsOrderNo),
    labelNo: firstNonEmpty(item.customerExpressNo, item.expressNo, item.trackingNo, item.tracking_no, item.labelNo, item.returnGoodsOrderNo)
  };
}

async function createWinitReturnApi({ order, dryRun = true, allowCreate = false, shippingQuote = null } = {}) {
  const customLogistics = isWinitCustomReturnLogistics(order);
  const customCandidate = customLogistics ? customWinitReturnCandidate(order) : null;
  const quote = shippingQuote || {
    platform: 'winit',
    quoted: false,
    candidates: customCandidate ? [customCandidate] : [],
    selected: customCandidate,
    message: customLogistics
      ? '万邑通本次使用客户提供的退货物流信息，不预约 Return Label 物流。'
      : '万邑通本次未提供客户退货物流信息，按 Return Label 否留空创建。'
  };
  const payload = buildReturnGoodsPayload(order, null);
  const returnTrackingProvided = Boolean(payload.expressNo);
  const logisticsCandidates = customCandidate ? [customCandidate] : [];

  const result = {
    platform: 'winit',
    mode: 'api',
    returnLogisticsMode: customLogistics ? 'custom' : 'auto',
    returnLabelRequired: false,
    returnTrackingProvided,
    customerReturnTrackingNo: payload.expressNo,
    customerReturnCarrierName: payload.supplierName,
    dryRun,
    created: false,
    shippingQuote: quote,
    selectedLogistics: customCandidate,
    logisticsCandidates,
    createPayloadPreview: {
      ...payload,
      phone: payload.phone ? '***' : '',
      email: payload.email ? '***' : ''
    }
  };
  if (!payload.outboundOrderNo || !payload.warehouseCode || !payload.ReturnGoodsList.length) {
    return {
      ...result,
      needsReview: true,
      message: '万邑通 API 创建缺少出库单号、仓库或 SKU'
    };
  }
  if (!allowCreate || dryRun) {
    return {
      ...result,
      message: returnTrackingProvided
        ? 'Dry-run: 万邑通 API 已完成查单和自选物流参数校验，确认会带客户退货物流号创建，Return Label 为否。'
        : 'Dry-run: 万邑通 API 已完成查单和创建参数校验；客户退货物流号为空也可创建，Return Label 为否。'
    };
  }

  const create = await winitCall('rma.returnGoodsOrder.createReturnGoodsOrder', payload);
  const data = dataOf(create.json) || {};
  const returnOrderNo = firstNonEmpty(data.returnGoodsOrderNo, data.return_order_no, data.orderNo);
  const rmaNo = firstNonEmpty(data.rmaNo, data.rma_no);
  result.createResponse = {
    status: create.status,
    ok: create.ok,
    message: winitMessage(create.json, create.error || '')
  };
  result.created = Boolean(create.ok && winitSuccess(create.json) && returnOrderNo);
  result.returnOrderNo = returnOrderNo;
  result.rmaNo = rmaNo;
  if (!result.created) {
    const createMessage = winitMessage(create.json, create.error || '万邑通 API 创建退货单失败');
    const alreadyCreated = /已生成退货订单|已有退货订单|可退货商品数量不足|数量不足/i.test(createMessage);
    if (alreadyCreated) {
      const existing = await resolveExistingReturnOrder({
        ...order,
        outboundOrderNo: payload.outboundOrderNo,
        customerOrderNo: payload.customerOrderNo,
        rmaNo
      });
      if (existing?.returnOrderNo) {
        result.created = true;
        result.returnOrderNo = existing.returnOrderNo;
        result.rmaNo = existing.rmaNo || rmaNo;
        result.trackingNo = existing.trackingNo || payload.expressNo || '';
        result.labelNo = '';
        result.labelFile = null;
        result.labelDownloadUrl = '';
        result.downloaded = false;
        result.message = returnTrackingProvided
          ? '万邑通 API 已找到既有退货单，并使用客户退货物流号，无需下载 Return Label。'
          : '万邑通 API 已找到既有退货单；客户退货物流号为空，无需下载 Return Label。';
        return result;
      }
    }
    result.needsReview = true;
    result.message = createMessage;
    result.rawTextSnippet = safeSnippet(create.json || create.text || create.error, 3000);
    return result;
  }

  result.trackingNo = firstNonEmpty(data.trackingNo, data.tracking_no, data.waybillNo, payload.expressNo);
  result.labelNo = '';
  result.labelFile = null;
  result.labelDownloadUrl = '';
  result.downloaded = false;
  result.message = returnTrackingProvided
    ? '万邑通 API 已创建退货单，并已上传客户退货物流号，无需下载 Return Label。'
    : '万邑通 API 已创建退货单；客户退货物流号为空，无需下载 Return Label。';
  return result;
}

async function probeWinitApi() {
  try {
    requireConfig();
    const response = await winitCall('rma.returnGoodsOrder.queryPSCList', {});
    return {
      platform: 'winit',
      ok: response.ok && winitSuccess(response.json),
      mode: 'api',
      status: response.status,
      message: winitMessage(response.json, response.error || '万邑通 API 已响应'),
      missingClientCredentials: !config.api.winit.clientId || !config.api.winit.clientSecret,
      rawTextSnippet: safeSnippet(response.json || response.text || response.error, 1200)
    };
  } catch (error) {
    return {
      platform: 'winit',
      ok: false,
      mode: 'api',
      error: error.message,
      missingClientCredentials: !config.api.winit.clientId || !config.api.winit.clientSecret,
      message: `万邑通 API 检查失败：${error.message}`
    };
  }
}

module.exports = {
  buildRequest,
  calculateWinitShippingApi,
  createWinitReturnApi,
  findWinitOrderApi,
  probeWinitApi,
  queryReturnLabel,
  signWinit,
  winitCall
};
