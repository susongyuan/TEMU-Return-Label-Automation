const { config } = require('../env');
const { normalizeOrderNo, parseOrderLine } = require('../order-normalizer');
const { queryEccangOrderApi } = require('../api/eccang');
const {
  createGoodcangReturnApi,
  finalizeGoodcangReturnsApi,
  findGoodcangOrderApi
} = require('../api/goodcang');
const { createWinitReturnApi, findWinitOrderApi } = require('../api/winit');
const { createWinitReturn } = require('./winit');

const SINGLE_ORDER_TIMEOUT_MS = 4 * 60 * 1000;
const ECCANG_EMPTY_TRACKING_RETRY_MS = 1200;

function clampConcurrency(value, total) {
  const number = Number(value);
  const concurrency = Number.isFinite(number) && number > 0 ? Math.floor(number) : config.orderConcurrency;
  return Math.max(1, Math.min(concurrency || 1, Math.max(1, total)));
}

function normalizeWinitOptions(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const strategy = String(source.stockStrategy || source.strategy || source.returnStrategy || 'photo-hold').trim();
  return {
    stockStrategy: ['photo-hold', 'direct-shelve', 'destroy'].includes(strategy) ? strategy : 'photo-hold',
    templateType: String(source.templateType || source.photoTemplateType || 'WINIT标准模板-开箱').trim() || 'WINIT标准模板-开箱'
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = clampConcurrency(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryEccangOrderForWorkflow(stOrderNo, log) {
  let eccang = await queryEccangOrderApi(stOrderNo);
  if (eccang.found && !eccang.trackingNo) {
    log?.('易仓已匹配订单但未返回跟踪号，短暂等待后重试一次');
    await sleep(ECCANG_EMPTY_TRACKING_RETRY_MS);
    const retryEccang = await queryEccangOrderApi(stOrderNo);
    if (retryEccang?.trackingNo || (!eccang.found && retryEccang?.found)) {
      eccang = retryEccang;
    }
  }
  return eccang;
}

async function getEccangOrder(stOrderNo, context, log) {
  if (!context.eccangCache) return queryEccangOrderForWorkflow(stOrderNo, log);
  if (!context.eccangCache.has(stOrderNo)) {
    const promise = queryEccangOrderForWorkflow(stOrderNo, log).catch(error => {
      context.eccangCache.delete(stOrderNo);
      throw error;
    });
    context.eccangCache.set(stOrderNo, promise);
  } else {
    log?.('复用同一任务内的易仓查单结果');
  }
  return context.eccangCache.get(stOrderNo);
}

function inferPlatform(eccangResult) {
  if (eccangResult.platform) return eccangResult.platform;
  const warehouse = String(eccangResult.warehouse || '').toLowerCase();
  if (/winit|万邑/.test(warehouse)) return 'winit';
  if (/goodcang|谷仓/.test(warehouse)) return 'goodcang';
  return '';
}

async function resolveWarehouseOrder(eccangResult, log) {
  if (!eccangResult.trackingNo) {
    return {
      platform: '',
      warehouseOrder: {
        found: false,
        message: '易仓没有返回跟踪号，按规则不使用 ST 订单号查询仓库'
      }
    };
  }

  const inferred = inferPlatform(eccangResult);
  const query = {
    trackingNo: eccangResult.trackingNo,
    warehouseOrderNo: eccangResult.warehouseOrderNo
  };

  if (inferred === 'goodcang') {
    const goodcang = await findGoodcangOrderApi(query);
    if (goodcang?.found) return { platform: 'goodcang', warehouseOrder: goodcang };
    const winit = await findWinitOrderApi(query);
    return winit?.found
      ? { platform: 'winit', warehouseOrder: winit }
      : { platform: '', warehouseOrder: goodcang?.found ? goodcang : winit || goodcang };
  }
  if (inferred === 'winit') {
    const winit = await findWinitOrderApi(query);
    if (winit?.found) return { platform: 'winit', warehouseOrder: winit };
    const goodcang = await findGoodcangOrderApi(query);
    return goodcang?.found
      ? { platform: 'goodcang', warehouseOrder: goodcang }
      : { platform: '', warehouseOrder: goodcang?.found ? goodcang : winit || goodcang };
  }

  log?.(`易仓返回跟踪号 ${eccangResult.trackingNo}，先查谷仓，再查万邑通`);
  const goodcang = await findGoodcangOrderApi(query);
  if (goodcang.found) return { platform: 'goodcang', warehouseOrder: goodcang };
  const winit = await findWinitOrderApi(query);
  if (winit.found) return { platform: 'winit', warehouseOrder: winit };
  return { platform: '', warehouseOrder: { found: false } };
}

async function processSingleOrder(orderInput, options = {}, context = {}) {
  const inputOrder = parseOrderLine(orderInput);
  const rawOrderNo = inputOrder.rawOrderNo;
  const dryRun = options.dryRun ?? config.dryRunDefault;
  const allowCreate = Boolean(options.allowCreate);
  const winitOptions = normalizeWinitOptions(options.winitOptions);
  const stOrderNo = inputOrder.stOrderNo || normalizeOrderNo(rawOrderNo);
  const customerReturnTrackingNo = inputOrder.customerReturnTrackingNo || '';
  const customerReturnCarrierName = inputOrder.customerReturnCarrierName || inputOrder.supplierName || '';
  const preferredReturnCourier = inputOrder.preferredReturnCourier || inputOrder.preferredCourier || inputOrder.preferredLogistics || customerReturnCarrierName || '';
  const manualSelectedLogistics = inputOrder.manualSelectedLogistics || inputOrder.manualRetryLogistics || null;
  const returnLogisticsMode = inputOrder.returnLogisticsMode || (customerReturnTrackingNo || customerReturnCarrierName ? 'custom' : 'auto');
  const result = {
    rawOrderNo,
    stOrderNo,
    customerReturnTrackingNo,
    customerReturnCarrierName,
    preferredReturnCourier,
    manualSelectedLogistics,
    returnLogisticsMode,
    status: 'running',
    steps: []
  };
  const log = message => {
    result.steps.push({ time: new Date().toISOString(), message });
    context.onUpdate?.(result);
  };

  try {
    log(`标准化订单号：${stOrderNo}`);
    const eccang = await getEccangOrder(stOrderNo, context, log);
    result.eccang = eccang;
    log(eccang.found ? '易仓 API 已匹配订单信息' : '易仓 API 未匹配到完整订单信息');

    const resolved = await resolveWarehouseOrder(eccang, log);
    result.platform = resolved.platform;
    result.warehouseOrder = resolved.warehouseOrder;

    if (!resolved.platform) {
      result.status = 'needs-review';
      result.error = resolved.warehouseOrder.message || '谷仓和万邑通都没有通过易仓跟踪号匹配到仓库订单';
      return result;
    }

    const createPayload = {
      order: {
        ...eccang,
        ...resolved.warehouseOrder,
        stOrderNo,
        customerReturnTrackingNo,
        returnExpressNo: customerReturnTrackingNo,
        customerReturnCarrierName,
        preferredReturnCourier,
        manualSelectedLogistics,
        returnCourier: customerReturnCarrierName,
        supplierName: customerReturnCarrierName,
        returnSupplierName: customerReturnCarrierName,
        returnLogisticsMode,
        rawOrderNo,
        trackingNo: eccang.trackingNo || resolved.warehouseOrder.trackingNumbers?.[0] || ''
      },
      dryRun,
      allowCreate,
      preferCrawlerOnly: options.preferCrawlerOnly ?? config.preferCrawlerOnly,
      winitOptions
    };

    if (allowCreate && !dryRun) {
      if (context.realCreatesDone >= config.realCreateMaxPerJob) {
        throw new Error(`真实创建被限制：每个任务最多 ${config.realCreateMaxPerJob} 单`);
      }
      context.realCreatesDone += 1;
    }

    const winitCustomLogistics = resolved.platform === 'winit' && returnLogisticsMode === 'custom';
    const useWinitCrawler = resolved.platform === 'winit' && allowCreate && !dryRun && !winitCustomLogistics;
    log(`${resolved.platform === 'goodcang' ? '谷仓' : '万邑通'} ${useWinitCrawler ? '页面' : 'API'} 退货单${dryRun ? '预检' : '创建'}（${returnLogisticsMode === 'custom' ? '自选物流' : '平台自动物流'}）`);
    if (resolved.platform === 'goodcang') {
      result.returnCreation = await createGoodcangReturnApi(createPayload);
    } else if (useWinitCrawler) {
      try {
        result.returnCreation = await createWinitReturn(createPayload);
      } catch (error) {
        log(`万邑通页面创建不可用，已回退到 API：${error.message}`);
        result.returnCreation = await createWinitReturnApi(createPayload);
        result.returnCreation = {
          ...result.returnCreation,
          fallbackFromCrawler: true,
          fallbackReason: error.message
        };
      }
    } else {
      result.returnCreation = await createWinitReturnApi(createPayload);
    }

    if (
      resolved.platform === 'goodcang' &&
      result.returnCreation?.draftOnly &&
      result.returnCreation?.returnOrderNo
    ) {
      context.goodcangDrafts?.push({
        rawOrderNo,
        stOrderNo,
        returnOrderNo: result.returnCreation.returnOrderNo,
        result
      });
    }

    result.status = result.returnCreation.created || dryRun ? 'done' : 'needs-review';
    if (result.returnCreation.needsReview) result.status = 'needs-review';
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    return result;
  }
}

async function processSingleOrderWithTimeout(orderInput, options = {}, context = {}) {
  let timer = null;
  const inputOrder = parseOrderLine(orderInput);
  try {
    return await Promise.race([
      processSingleOrder(inputOrder, options, context),
      new Promise(resolve => {
        timer = setTimeout(() => {
          const stOrderNo = inputOrder.stOrderNo || normalizeOrderNo(inputOrder.rawOrderNo);
          resolve({
            rawOrderNo: inputOrder.rawOrderNo,
            stOrderNo,
            customerReturnTrackingNo: inputOrder.customerReturnTrackingNo || '',
            customerReturnCarrierName: inputOrder.customerReturnCarrierName || inputOrder.supplierName || '',
            returnLogisticsMode: inputOrder.returnLogisticsMode || (inputOrder.customerReturnTrackingNo || inputOrder.customerReturnCarrierName || inputOrder.supplierName ? 'custom' : 'auto'),
            status: 'failed',
            steps: [],
            error: `处理超时：单个订单超过 ${Math.round(SINGLE_ORDER_TIMEOUT_MS / 60000)} 分钟未完成，请检查平台登录或页面响应`
          });
        }, SINGLE_ORDER_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processOrders(orders, options = {}, context = {}) {
  const shared = {
    realCreatesDone: 0,
    goodcangDrafts: [],
    eccangCache: new Map(),
    onUpdate: context.onUpdate
  };
  const concurrency = clampConcurrency(options.concurrency ?? config.orderConcurrency, orders.length);
  const results = await mapWithConcurrency(orders, concurrency, async orderInput => {
    const result = await processSingleOrderWithTimeout(orderInput, options, shared);
    context.onResult?.(result);
    return result;
  });

  const shouldFinalizeGoodcang =
    Boolean(options.allowCreate) &&
    !(options.dryRun ?? config.dryRunDefault) &&
    shared.goodcangDrafts.length > 0;
  if (shouldFinalizeGoodcang) {
    const returnOrderNos = shared.goodcangDrafts.map(item => item.returnOrderNo);
    const finalization = await finalizeGoodcangReturnsApi({
      returnOrderNos,
      dryRun: false,
      allowCreate: true
    });

    const detailsByOrder = new Map(
      (finalization.details || []).map(detail => [detail.returnOrderNo, detail])
    );
    for (const draft of shared.goodcangDrafts) {
      const detail = detailsByOrder.get(draft.returnOrderNo);
      draft.result.returnCreation = {
        ...draft.result.returnCreation,
        batchFinalization: finalization,
        submitted: finalization.submitted,
        downloaded: finalization.downloaded,
        trackingNo: detail?.trackingNo || draft.result.returnCreation.trackingNo || '',
        labelNo: detail?.trackingNo || draft.result.returnCreation.labelNo || '',
        status: detail?.status || draft.result.returnCreation.status,
        feeDetails: detail?.feeDetails || draft.result.returnCreation.feeDetails,
        message: finalization.message || draft.result.returnCreation.message
      };
      if (!finalization.submitted) {
        draft.result.status = 'needs-review';
        draft.result.error = finalization.message || '谷仓批量提交失败';
      } else {
        draft.result.status = 'done';
      }
      context.onResult?.(draft.result);
    }
  }

  return results;
}

module.exports = {
  processOrders,
  processSingleOrder
};
