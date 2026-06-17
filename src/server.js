const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const { config } = require('./env');
const { getPool } = require('./db');
const { createJob, getInternalJob, getJob, listJobs } = require('./jobs');
const { deleteHistoryRecord, getHistoryRecord, listHistory } = require('./history');
const { resolveOperatorIdentity } = require('./operator-auth');
const { probeEccangApi } = require('./api/eccang');
const { probeGoodcangApi } = require('./api/goodcang');
const { probeWinitApi } = require('./api/winit');

const app = express();
const PUBLIC_DIR = path.join(config.moduleDir, 'public');
const PROBE_PLATFORM_TIMEOUT_MS = 35000;

function withTimeout(promise, ms, fallbackFactory) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallbackFactory()), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: '请求 JSON 格式错误'
      }
    });
    return;
  }
  next(error);
});
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    apiMode: config.apiMode,
    dryRunDefault: config.dryRunDefault,
    realCreateMaxPerJob: config.realCreateMaxPerJob,
    orderConcurrency: config.orderConcurrency,
    maxOrderConcurrency: config.maxOrderConcurrency,
    preferCrawlerOnly: config.preferCrawlerOnly
  });
});

app.get('/api/jobs', (req, res) => {
  res.json({ data: listJobs() });
});

app.post('/api/return-label/exchange', async (req, res) => {
  try {
    const handoffCode = String(req.body?.handoffCode || req.body?.handoff || '').trim();
    if (!handoffCode) throw new Error('缺少一次性跳转凭证');
    const response = await fetch(`${config.dashboardBaseUrl}/api/return-label/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffCode })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '一次性跳转凭证无效');
    const operator = await resolveOperatorIdentity(getPool(), {
      operatorKey: payload.data?.operatorKey,
      operatorName: payload.data?.operatorName
    });
    res.json({ data: operator });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'RETURN_LABEL_HANDOFF_EXCHANGE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/jobs', async (req, res) => {
  try {
    if (req.body && req.body.dryRun === false && req.body.allowCreate === true) {
      await resolveOperatorIdentity(getPool(), {
        authToken: req.body.authToken || req.body.token,
        operatorKey: req.body.operatorKey,
        operatorName: req.body.operatorName
      });
    }
    res.status(202).json({ data: createJob(req.body || {}) });
  } catch (error) {
    res.status(error.statusCode || (/登录|账号|停用|匹配/.test(error.message) ? 401 : 500)).json({
      error: {
        code: 'JOB_CREATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/preflight-jobs', (req, res) => {
  try {
    res.status(202).json({ data: createJob({ ...(req.body || {}), preflight: true }) });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: {
        code: 'PREFLIGHT_JOB_CREATE_FAILED',
        message: error.message
      }
    });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: '任务不存在' } });
    return;
  }
  res.json({ data: job });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = getInternalJob(req.params.id);
  if (!job) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const write = payload => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  write({ event: 'snapshot', job: getJob(job.id), at: new Date().toISOString() });
  job.emitter.on('event', write);
  req.on('close', () => {
    job.emitter.off('event', write);
  });
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({
      data: await listHistory({
        platform: req.query.platform || 'all',
        keyword: req.query.keyword || '',
        status: req.query.status || '',
        limit: req.query.limit || 200
      })
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'HISTORY_LOAD_FAILED',
        message: error.message
      }
    });
  }
});

app.get('/api/history/:id', async (req, res) => {
  try {
    const record = await getHistoryRecord(req.params.id);
    if (!record) {
      res.status(404).json({ error: { code: 'HISTORY_NOT_FOUND', message: '历史记录不存在' } });
      return;
    }
    res.json({ data: record });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'HISTORY_RECORD_LOAD_FAILED',
        message: error.message
      }
    });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    const deleted = await deleteHistoryRecord(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: { code: 'HISTORY_NOT_FOUND', message: '历史记录不存在' } });
      return;
    }
    res.json({ data: { deleted: true, id: req.params.id } });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'HISTORY_DELETE_FAILED',
        message: error.message
      }
    });
  }
});

app.get('/api/return-label/history', async (req, res) => {
  try {
    res.json({
      data: await listHistory({
      platform: req.query.platform || 'all',
      keyword: req.query.keyword || '',
      status: req.query.status || '',
      limit: req.query.limit || 200
    })
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'RETURN_LABEL_HISTORY_LOAD_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/probe', async (req, res) => {
  const platforms = req.body?.platforms || ['eccang', 'goodcang', 'winit'];
  const probeMap = {
    eccang: probeEccangApi,
    goodcang: probeGoodcangApi,
    winit: probeWinitApi
  };
  const probes = [];
  for (const platform of platforms) {
    const probe = probeMap[platform];
    if (!probe) continue;
    try {
      const result = await withTimeout(
        probe(),
        PROBE_PLATFORM_TIMEOUT_MS,
        () => ({
          platform,
          ok: false,
          mode: 'api',
          error: `API 检查超过 ${Math.round(PROBE_PLATFORM_TIMEOUT_MS / 1000)} 秒`,
          message: `${platform} API 检查超时`
        })
      );
      probes.push(result);
    } catch (error) {
      probes.push({
        platform,
        ok: false,
        mode: 'api',
        error: error.message,
        message: `${platform} API 检查失败：${error.message}`
      });
    }
  }
  res.json({ data: probes });
});

app.get('/api/labels/:platform/:fileName', (req, res) => {
  const platform = String(req.params.platform || '').replace(/[^a-z0-9_-]/gi, '');
  const fileName = path.basename(String(req.params.fileName || ''));
  const labelsRoot = path.join(config.moduleDir, '.runtime', 'labels');
  const filePath = path.resolve(labelsRoot, platform, fileName);
  if (!filePath.startsWith(path.resolve(labelsRoot) + path.sep)) {
    res.status(400).json({ error: { code: 'BAD_LABEL_PATH', message: '面单路径非法' } });
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: { code: 'LABEL_NOT_FOUND', message: '面单文件不存在' } });
    return;
  }
  res.download(filePath);
});

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(config.port, config.host, () => {
  console.log(`Return label automation: http://${config.host}:${config.port}`);
  console.log(`API mode: ${config.apiMode}; dryRunDefault=${config.dryRunDefault}; realCreateMaxPerJob=${config.realCreateMaxPerJob}; orderConcurrency=${config.orderConcurrency}; maxOrderConcurrency=${config.maxOrderConcurrency}`);
});
