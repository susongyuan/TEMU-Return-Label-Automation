const http = require('http');
const fs = require('fs');

const DEFAULT_ORDERS = [
  'PO-012-01478546750070498',
  'G1915-260616-0607',
  'PO-012-01478546750070498-D01',
  'PO-012-01478546750070498-D02',
  'G1915-260616-0607-D01',
  'G1915-260616-0607-D02',
  'PO-012-01478546750070498-D03',
  'PO-012-01478546750070498-D04',
  'G1915-260616-0607-D03',
  'G1915-260616-0607-D04'
];

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find(item => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function readOrdersFile(file) {
  if (!file) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function requestJson(method, targetUrl, body) {
  const url = new URL(targetUrl);
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
      });
      res.on('end', () => {
        let json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { error: { message: text } };
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(json?.error?.message || `HTTP ${res.statusCode}`);
          error.response = json;
          reject(error);
          return;
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const baseUrl = argValue('base-url', process.env.RETURN_AUTOMATION_TEST_URL || 'http://127.0.0.1:3206');
  const sourceOrders = readOrdersFile(argValue('orders-file', ''));
  const availableOrders = sourceOrders.length ? sourceOrders : DEFAULT_ORDERS;
  const count = Math.min(Math.max(Number(argValue('count', Math.min(10, availableOrders.length))) || 10, 1), 30);
  const concurrency = Math.min(Math.max(Number(argValue('concurrency', count)) || count, 1), 30);
  const timeoutMs = Math.max(Number(argValue('timeout-ms', 10 * 60 * 1000)) || 10 * 60 * 1000, 30 * 1000);
  const orders = availableOrders.slice(0, count);
  if (orders.length !== count) {
    throw new Error(`Requested ${count} orders, but only ${orders.length} are available. Pass --orders-file=path with more orders.`);
  }

  console.log(JSON.stringify({ event: 'submit', baseUrl, count, concurrency, source: sourceOrders.length ? 'orders-file' : 'default' }, null, 2));
  const created = await requestJson('POST', `${baseUrl}/api/preflight-jobs`, {
    input: orders.join('\n'),
    dryRun: true,
    allowCreate: false,
    preflight: true,
    concurrency
  });
  const job = created.data || created;
  if (!job.id) throw new Error('Preflight job id missing');
  console.log(JSON.stringify({ event: 'created', id: job.id, status: job.status }, null, 2));

  const startedAt = Date.now();
  let latest = job;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1500);
    const payload = await requestJson('GET', `${baseUrl}/api/jobs/${encodeURIComponent(job.id)}`);
    latest = payload.data || payload;
    const done = ['finished', 'failed', 'cancelled'].includes(String(latest.status || '').toLowerCase());
    console.log(JSON.stringify({
      event: 'poll',
      id: latest.id,
      status: latest.status,
      rows: Array.isArray(latest.results) ? latest.results.length : 0
    }));
    if (done) break;
  }

  if (!['finished', 'completed', 'complete'].includes(String(latest.status || '').toLowerCase())) {
    throw new Error(`Preflight job did not finish: ${latest.status}`);
  }
  const results = Array.isArray(latest.results) ? latest.results : [];
  if (results.length !== orders.length) {
    throw new Error(`Expected ${orders.length} results, got ${results.length}`);
  }
  console.log(JSON.stringify({
    event: 'complete',
    id: latest.id,
    status: latest.status,
    rows: results.length,
    statuses: results.reduce((acc, row) => {
      const key = row.displayStatus || row.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
