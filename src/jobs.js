const { EventEmitter } = require('events');
const { normalizeOrders } = require('./order-normalizer');
const { processOrders } = require('./automation/workflow');
const { config } = require('./env');
const { saveJobHistory } = require('./history');

const jobs = new Map();
let nextJobId = 1;

const STATUS_LABELS = {
  preview: '待预检',
  queued: '待处理',
  pending: '待处理',
  processing: '处理中',
  running: '处理中',
  matching: '匹配中',
  matched: '已匹配',
  creating: '创建中',
  dryrun: '预检完成',
  'dry-run': '预检完成',
  skipped: '已跳过',
  'needs-review': '需复核',
  review: '需复核',
  created: '已创建',
  finished: '已完成',
  completed: '已完成',
  complete: '已完成',
  done: '已完成',
  success: '成功',
  succeeded: '成功',
  failed: '失败',
  error: '失败',
  cancelled: '已取消'
};

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function getReturnOrderNo(result) {
  const creation = result.returnCreation || {};
  return firstValue(result.returnOrderNo, creation.returnOrderNo, creation.orderNo, creation.id);
}

function getLabelNo(result) {
  const creation = result.returnCreation || {};
  return firstValue(
    result.labelNo,
    result.waybillNo,
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

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || String(status || '');
}

function deriveDisplayStatus(result = {}) {
  const key = String(result.status || '').toLowerCase();
  const creation = result.returnCreation || {};
  if (['needs-review', 'review', 'skipped'].includes(key)) {
    return key;
  }
  if (creation.dryRun || (key === 'done' && !getReturnOrderNo(result) && !getLabelNo(result))) {
    return 'dry-run';
  }
  if (key === 'done' && (getReturnOrderNo(result) || getLabelNo(result))) {
    return 'created';
  }
  return result.displayStatus || result.status || '';
}

function decorateResult(result) {
  if (!result) return result;
  const displayStatus = deriveDisplayStatus(result);
  return {
    ...result,
    displayStatus,
    statusLabel: statusLabel(displayStatus)
  };
}

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    status: job.status,
    options: job.options,
    orders: job.orders,
    results: job.results.map(decorateResult),
    error: job.error
  };
}

function emit(job, event, data = {}) {
  job.emitter.emit('event', {
    event,
    job: publicJob(job),
    data,
    at: new Date().toISOString()
  });
}

function upsertResult(job, result) {
  const next = decorateResult(result);
  if (!next?.stOrderNo && !next?.rawOrderNo) return;
  const index = job.results.findIndex(item =>
    (next.stOrderNo && item.stOrderNo === next.stOrderNo) ||
    (next.rawOrderNo && item.rawOrderNo === next.rawOrderNo)
  );
  if (index >= 0) {
    job.results[index] = { ...job.results[index], ...next };
  } else {
    job.results.push(next);
  }
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  emit(job, 'started');
  try {
    const results = await processOrders(job.orders, job.options, {
      onUpdate: result => {
        const decorated = decorateResult(result);
        upsertResult(job, decorated);
        emit(job, 'row-update', decorated);
      },
      onResult: result => {
        const decorated = decorateResult(result);
        upsertResult(job, decorated);
        emit(job, 'row-result', decorated);
      }
    });
    job.results = results.map(decorateResult);
    job.status = 'finished';
    job.finishedAt = new Date().toISOString();
    await saveJobHistory(job);
    emit(job, 'finished');
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    await saveJobHistory(job);
    emit(job, 'failed');
  }
}

function createJob(body = {}) {
  const orders = normalizeOrders(body.orders || body.input || '');
  if (!orders.length) {
    const error = new Error('请输入至少一个订单号');
    error.statusCode = 400;
    throw error;
  }
  const preflight = body.preflight == null ? null : Boolean(body.preflight);
  const allowCreate = preflight ? false : Boolean(body.allowCreate);
  const dryRun = preflight == null
    ? (body.dryRun == null ? config.dryRunDefault : Boolean(body.dryRun))
    : true;
  if (!dryRun && !allowCreate) {
    const error = new Error('真实创建必须勾选允许真实创建；否则请使用预检模式');
    error.statusCode = 400;
    throw error;
  }
  if (allowCreate && !dryRun && orders.length > config.realCreateMaxPerJob) {
    const error = new Error(`真实创建每次最多 ${config.realCreateMaxPerJob} 单，请缩小批次`);
    error.statusCode = 400;
    throw error;
  }
  const requestedConcurrency = Math.max(1, Number(body.concurrency || config.orderConcurrency) || 1);
  const maxConcurrency = Math.max(1, config.maxOrderConcurrency || config.orderConcurrency || 1);
  const concurrency = Math.min(requestedConcurrency, maxConcurrency);
  const job = {
    id: String(nextJobId++),
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    status: 'queued',
    orders,
    results: [],
    options: {
      dryRun,
      allowCreate,
      concurrency,
      preferCrawlerOnly: body.preferCrawlerOnly == null ? config.preferCrawlerOnly : Boolean(body.preferCrawlerOnly)
    },
    operator: body.operator || {
      authToken: body.authToken || body.token,
      operatorKey: body.operatorKey,
      operatorName: body.operatorName || body.name
    },
    emitter: new EventEmitter()
  };
  jobs.set(job.id, job);
  setImmediate(() => runJob(job));
  return publicJob(job);
}

function getJob(id) {
  const job = jobs.get(String(id));
  return job ? publicJob(job) : null;
}

function getInternalJob(id) {
  return jobs.get(String(id));
}

function listJobs() {
  return [...jobs.values()].slice(-20).reverse().map(publicJob);
}

module.exports = {
  createJob,
  getInternalJob,
  getJob,
  listJobs
};
