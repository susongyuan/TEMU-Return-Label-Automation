const { normalizeOrderNo } = require('./order-normalizer');
const { queryEccangOrderApi } = require('./api/eccang');
const {
  calculateGoodcangShippingApi,
  findGoodcangOrderApi,
  queryGoodcangInventoryBySkus
} = require('./api/goodcang');
const {
  calculateWinitShippingApi,
  findWinitOrderApi
} = require('./api/winit');
const { firstNonEmpty } = require('./api/common');

function normalizePlatformMode(value = 'auto') {
  const text = String(value || '').trim().toLowerCase();
  if (['goodcang', 'gc', '谷仓'].includes(text)) return 'goodcang';
  if (['winit', 'wyt', '万邑通'].includes(text)) return 'winit';
  return 'auto';
}

function inferPlatform(eccangResult = {}) {
  if (eccangResult.platform) return eccangResult.platform;
  const warehouseRaw = String(firstNonEmpty(eccangResult.warehouseCode, eccangResult.warehouse));
  const warehouse = warehouseRaw.toLowerCase();
  if (/winit|万邑/.test(warehouse)) return 'winit';
  if (/goodcang|gucang|谷仓/.test(warehouse)) return 'goodcang';
  if (/^w[-_]/i.test(warehouseRaw)) return 'winit';
  if (/^g[-_]/i.test(warehouseRaw)) return 'goodcang';
  return '';
}

function platformLabel(platform) {
  return platform === 'goodcang' ? '谷仓' : platform === 'winit' ? '万邑通' : '未知';
}

function unique(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean)
  )];
}

function meaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  const text = String(value).trim();
  if (!text) return false;
  return !['unknown', 'customer', 'return@example.com', '0000000000'].includes(text.toLowerCase());
}

function mergeMeaningfulObjects(...objects) {
  const output = {};
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    for (const [key, value] of Object.entries(object)) {
      if (meaningfulValue(value)) output[key] = value;
    }
  }
  return output;
}

function firstMeaningfulArray(...values) {
  return values.find(value => Array.isArray(value) && value.length) || [];
}

function regionTokensFromWarehouse(value = '') {
  const raw = String(value || '').trim().toUpperCase();
  const withoutPrefix = raw.replace(/^(G|W)[-_]/, '');
  const tokens = unique([
    raw,
    withoutPrefix,
    withoutPrefix.replace(/TW$/, ''),
    withoutPrefix.replace(/T$/, ''),
    withoutPrefix === 'GB' ? 'UK' : '',
    withoutPrefix === 'UK' ? 'GB' : ''
  ]);
  return tokens.filter(token => /^[A-Z0-9_-]{2,12}$/.test(token));
}

function goodcangTokenOptions(token = '') {
  const raw = String(token || '').trim().toUpperCase();
  if (!raw) return [];
  const core = raw.replace(/^(G|W)[-_]/, '');
  const normalizedCore = (core === 'GB' || core === 'UKTW') ? 'UK' : core;
  if (/^G[-_]/.test(raw)) return unique([raw, normalizedCore]);
  if (/^W[-_]/.test(raw)) return unique([normalizedCore]);
  return unique([normalizedCore]);
}

function winitTokenOptions(token = '') {
  const raw = String(token || '').trim().toUpperCase();
  if (!raw) return [];
  const core = raw.replace(/^(G|W)[-_]/, '');
  const regionWarehouseCodes = {
    GB: ['UKTW', 'UK0001', 'UKBH', 'UKBM', 'UKGF', 'UKKM'],
    UK: ['UKTW', 'UK0001', 'UKBH', 'UKBM', 'UKGF', 'UKKM'],
    UKTW: ['UKTW', 'UK0001', 'UKBH', 'UKBM', 'UKGF', 'UKKM'],
    DE: ['DE0001', 'DEBR2', 'DENW3'],
    US: ['US0001', 'US0003', 'USGA', 'USKY2', 'USKY3', 'USNJ', 'USWC2', 'USWC5'],
    AU: ['AUME', 'EWD'],
    CA: ['CATO']
  };
  if (regionWarehouseCodes[core]) return regionWarehouseCodes[core];
  if (/^W[-_]/.test(raw)) return [core];
  return [raw];
}

function goodcangWarehouseCandidates(order = {}, warehouseOrder = {}) {
  const address = order.address || {};
  const country = String(address.countryCode || '').toUpperCase();
  const fromWarehouse = [
    ...regionTokensFromWarehouse(warehouseOrder.warehouseCode),
    ...regionTokensFromWarehouse(warehouseOrder.warehouse),
    ...regionTokensFromWarehouse(order.warehouseCode),
    ...regionTokensFromWarehouse(order.warehouse)
  ];
  const countryFallback = {
    GB: ['UK'],
    UK: ['UK'],
    DE: ['DE'],
    US: ['US'],
    AU: ['AU'],
    CA: ['CA'],
    FR: ['FR'],
    ES: ['ES'],
    IT: ['IT']
  }[country] || [country];
  return unique([
    ...fromWarehouse.flatMap(goodcangTokenOptions),
    ...countryFallback
  ]);
}

function winitWarehouseCandidates(order = {}, warehouseOrder = {}) {
  const address = order.address || {};
  const country = String(address.countryCode || '').toUpperCase();
  const tokens = unique([
    ...regionTokensFromWarehouse(warehouseOrder.warehouseCode),
    ...regionTokensFromWarehouse(warehouseOrder.warehouse),
    ...regionTokensFromWarehouse(order.warehouseCode),
    ...regionTokensFromWarehouse(order.warehouse)
  ]);
  const mapped = tokens.flatMap(winitTokenOptions);
  const countryFallback = {
    GB: ['UKTW', 'UK0001'],
    UK: ['UKTW', 'UK0001'],
    US: ['US0001', 'US0003'],
    AU: ['AUME', 'EWD'],
    CA: ['CATO'],
    DE: ['DE0001', 'DEBR2']
  }[country] || [];
  return unique([
    ...mapped,
    ...countryFallback
  ]);
}

function quoteWarehouseCandidates(platform, order = {}, warehouseOrder = {}) {
  return platform === 'goodcang'
    ? goodcangWarehouseCandidates(order, warehouseOrder)
    : winitWarehouseCandidates(order, warehouseOrder);
}

function productSkus(products = []) {
  return unique(products.map(item => firstNonEmpty(item.warehouseSku, item.sku, item.productCode)));
}

async function inventoryWarehouseCandidates(platform, baseInput = {}) {
  if (platform !== 'goodcang') return { candidates: [], inventory: null };
  const skus = productSkus(baseInput.products);
  if (!skus.length) return { candidates: [], inventory: null };
  const inventory = await queryGoodcangInventoryBySkus(skus).catch(error => ({
    platform,
    found: false,
    items: [],
    warehouseCandidates: [],
    message: error.message
  }));
  const products = Array.isArray(baseInput.products) ? baseInput.products : [];
  const candidates = (inventory.warehouseCandidates || [])
    .filter(candidate => {
      const items = candidate.items || [];
      return products.every(product => {
        const sku = firstNonEmpty(product.warehouseSku, product.sku, product.productCode);
        const required = Number(product.quantity) || 1;
        const stock = items.find(item => item.sku === sku || item.productBarcode === sku);
        return stock && stock.sellable >= required;
      });
    })
    .map(candidate => candidate.warehouseCode);
  return { candidates, inventory };
}

function pricedCalculatorCount(quote = {}) {
  const candidates = Array.isArray(quote.calculatorCandidates)
    ? quote.calculatorCandidates
    : (Array.isArray(quote.feeCandidates) ? quote.feeCandidates : []);
  return candidates.filter(item =>
    item &&
    item.price !== null &&
    item.price !== undefined &&
    item.price !== '' &&
    Number.isFinite(Number(item.price))
  ).length;
}

function usableTrackingNo(value = '') {
  const text = String(value || '').trim();
  if (!text || /^SYS\d+/i.test(text)) return '';
  return text;
}

function queryForEccang(eccang = {}) {
  return {
    trackingNo: usableTrackingNo(eccang.trackingNo),
    warehouseOrderNo: eccang.warehouseOrderNo || '',
    orderCode: eccang.warehouseOrderNo || ''
  };
}

async function findWarehouseOrder(platform, eccang) {
  const query = queryForEccang(eccang);
  if (platform === 'goodcang') return findGoodcangOrderApi(query);
  if (platform === 'winit') return findWinitOrderApi(query);
  return { platform, found: false, message: '未知仓库平台' };
}

async function calculatePlatformQuote(platform, quoteInput) {
  return platform === 'goodcang'
    ? calculateGoodcangShippingApi(quoteInput)
    : calculateWinitShippingApi(quoteInput);
}

function normalizeAddressSupplement(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const postcode = firstNonEmpty(value.postcode, value.zipCode, value.zipcode, value.postalCode, value.postal);
  return mergeMeaningfulObjects({
    countryCode: firstNonEmpty(value.countryCode, value.country, value.country_code),
    state: firstNonEmpty(value.state, value.province, value.region),
    city: value.city,
    postcode,
    address1: firstNonEmpty(value.address1, value.address),
    address2: value.address2
  });
}

function mergeAddressWithSupplement(baseAddress = {}, addressSupplement = {}) {
  const address = { ...baseAddress };
  for (const [key, value] of Object.entries(addressSupplement || {})) {
    if (!meaningfulValue(address[key]) && meaningfulValue(value)) {
      address[key] = value;
    }
  }
  return address;
}

function buildQuoteBaseInput(eccang = {}, warehouseOrder = {}, addressSupplement = {}) {
  const warehouseFound = Boolean(warehouseOrder?.found);
  const warehouseProducts = firstMeaningfulArray(warehouseOrder.products);
  const eccangProducts = firstMeaningfulArray(eccang.products);
  const products = firstMeaningfulArray(warehouseProducts, eccangProducts);
  const address = mergeAddressWithSupplement(
    mergeMeaningfulObjects(eccang.address, warehouseOrder.address),
    addressSupplement
  );
  const base = {
    ...eccang,
    ...(warehouseFound ? warehouseOrder : {}),
    products,
    address,
    primarySku: firstNonEmpty(warehouseOrder.primarySku, eccang.primarySku, products[0]?.warehouseSku, products[0]?.sku),
    quantity: firstNonEmpty(warehouseOrder.quantity, eccang.quantity, products.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1),
    stOrderNo: eccang.stOrderNo,
    rawOrderNo: eccang.rawOrderNo || eccang.stOrderNo,
    trackingNo: firstNonEmpty(eccang.trackingNo, warehouseOrder.trackingNo)
  };
  return base;
}

function quoteDataSourceLabel(warehouseOrder = {}, quoteInput = {}) {
  const supplementPostcode = String(quoteInput.addressSupplement?.postcode || '').trim();
  const usedSupplementPostcode = supplementPostcode &&
    String(quoteInput.address?.postcode || '').trim() === supplementPostcode &&
    !meaningfulValue(warehouseOrder.address?.postcode);
  if (usedSupplementPostcode) {
    return warehouseOrder?.found ? '平台仓库单，运营补充邮编试算' : '易仓订单，运营补充邮编跨平台试算';
  }
  if (!warehouseOrder?.found) return '易仓地址/SKU跨平台试算';
  const missingProducts = !Array.isArray(warehouseOrder.products) || !warehouseOrder.products.length;
  const missingCountry = !meaningfulValue(warehouseOrder.address?.countryCode);
  const missingPostcode = !meaningfulValue(warehouseOrder.address?.postcode);
  if (missingProducts || missingCountry || missingPostcode) return '平台仓库单，易仓补充地址/SKU';
  if (quoteInput.rawOrderNo && quoteInput.stOrderNo) return '平台仓库单试算';
  return '平台仓库单';
}

function missingQuoteInputMessage(baseInput = {}) {
  const address = baseInput.address || {};
  const missing = [];
  if (!meaningfulValue(address.countryCode)) missing.push('国家');
  if (!meaningfulValue(address.postcode)) missing.push('邮编');
  if (!Array.isArray(baseInput.products) || !baseInput.products.length) missing.push('SKU');
  if (!missing.length) return '订单仍缺少试算必需字段，请检查订单、仓库和 SKU 信息';
  const hint = missing.includes('邮编')
    ? '；待发货或仓库单缺邮编时，请在侧边栏补充邮编后再试算'
    : '；请检查易仓订单和仓库单资料';
  return `订单试算缺少${missing.join('、')}${hint}`;
}

async function quotePlatform(platform, eccang, addressSupplement = {}) {
  const inferredPlatform = inferPlatform(eccang);
  const lookupQuery = queryForEccang(eccang);
  const shouldLookupWarehouseOrder = (!inferredPlatform || inferredPlatform === platform) &&
    Boolean(lookupQuery.trackingNo || lookupQuery.warehouseOrderNo || lookupQuery.orderCode);
  const warehouseOrder = shouldLookupWarehouseOrder
    ? await findWarehouseOrder(platform, eccang).catch(error => ({
      platform,
      found: false,
      message: error.message
    }))
    : {
      platform,
      found: false,
      source: `${platform}-api`,
      message: `易仓识别原仓库为${platformLabel(inferredPlatform)}，本次按${platformLabel(platform)}通用计算器直接使用易仓地址/SKU试算`
    };
  const baseInput = {
    ...buildQuoteBaseInput(eccang, warehouseOrder, addressSupplement),
    addressSupplement
  };
  const inventoryResult = await inventoryWarehouseCandidates(platform, baseInput);
  const warehouseCandidates = unique([
    ...inventoryResult.candidates,
    ...quoteWarehouseCandidates(platform, eccang, warehouseOrder)
  ]);
  const address = baseInput.address || {};
  const hasProducts = Array.isArray(baseInput.products) && baseInput.products.length > 0;
  if (!address.countryCode || !address.postcode || !hasProducts) {
    return {
      platform,
      platformLabel: platformLabel(platform),
      warehouseOrder,
      quote: {
        platform,
        quoted: false,
        candidates: [],
        selected: null,
        usedWarehouseCode: warehouseCandidates[0] || '',
        triedWarehouseCodes: [],
        fallbackFromEccang: !warehouseOrder?.found,
        dataSource: quoteDataSourceLabel(warehouseOrder, baseInput),
        inventory: inventoryResult.inventory,
        message: missingQuoteInputMessage(baseInput),
        input: {
          warehouseCode: warehouseCandidates[0] || '',
          address,
          products: baseInput.products || []
        }
      }
    };
  }
  const triedWarehouseCodes = [];
  let quote = null;

  for (const warehouseCode of warehouseCandidates) {
    triedWarehouseCodes.push(warehouseCode);
    const quoteInput = {
      ...baseInput,
      warehouseCode,
      warehouse_code: warehouseCode,
      warehouse: warehouseCode
    };
    quote = await calculatePlatformQuote(platform, quoteInput).catch(error => ({
      platform,
      quoted: false,
      candidates: [],
      selected: null,
      message: error.message
    }));
    quote = {
      ...quote,
      usedWarehouseCode: warehouseCode,
      triedWarehouseCodes: [...triedWarehouseCodes],
      fallbackFromEccang: !warehouseOrder?.found,
      dataSource: quoteDataSourceLabel(warehouseOrder, baseInput),
      inventory: inventoryResult.inventory,
      input: {
        warehouseCode,
        address,
        products: baseInput.products || []
      }
    };
    if (pricedCalculatorCount(quote) > 0) break;
  }

  if (!quote) {
    quote = {
      platform,
      quoted: false,
      candidates: [],
      selected: null,
      triedWarehouseCodes,
      fallbackFromEccang: !warehouseOrder?.found,
      dataSource: quoteDataSourceLabel(warehouseOrder, baseInput),
      inventory: inventoryResult.inventory,
      input: {
        warehouseCode: warehouseCandidates[0] || '',
        address,
        products: baseInput.products || []
      },
      message: '未找到可用于该平台试算的仓库代码'
    };
  }

  return {
    platform,
    platformLabel: platformLabel(platform),
    warehouseOrder,
    quote
  };
}

function platformsForMode(mode, eccang) {
  if (['goodcang', 'winit'].includes(mode)) return [mode];
  const inferred = inferPlatform(eccang);
  return inferred ? [inferred] : [];
}

async function calculateShippingQuotes({ orderNo, platform = 'auto', addressSupplement = {}, postcode = '' } = {}) {
  const rawOrderNo = String(orderNo || '').trim();
  if (!rawOrderNo) {
    const error = new Error('请输入易仓完整订单号');
    error.statusCode = 400;
    throw error;
  }

  const mode = normalizePlatformMode(platform);
  const stOrderNo = normalizeOrderNo(rawOrderNo);
  const eccang = await queryEccangOrderApi(stOrderNo, { quoteMode: true });
  const addressSupplementInput = addressSupplement && typeof addressSupplement === 'object'
    ? addressSupplement
    : {};
  const supplement = normalizeAddressSupplement({
    ...addressSupplementInput,
    postcode: firstNonEmpty(postcode, addressSupplementInput.postcode)
  });
  const targets = platformsForMode(mode, eccang);
  if (!targets.length) {
    const error = new Error('易仓未识别出谷仓/万邑通仓库来源，请手动选择计算平台');
    error.statusCode = 400;
    throw error;
  }
  const quotes = [];

  for (const target of targets) {
    const item = await quotePlatform(target, {
      ...eccang,
      rawOrderNo,
      stOrderNo
    }, supplement);
    quotes.push(item);
  }

  return {
    rawOrderNo,
    stOrderNo,
    mode,
    inferredPlatform: inferPlatform(eccang),
    addressSupplement: supplement,
    generatedAt: new Date().toISOString(),
    eccang,
    quotes
  };
}

module.exports = {
  calculateShippingQuotes,
  normalizePlatformMode
};
