const { normalizeOrders } = require('./order-normalizer');
const { probeEccangApi } = require('./api/eccang');
const { probeGoodcangApi } = require('./api/goodcang');
const { probeWinitApi } = require('./api/winit');
const { processOrders } = require('./automation/workflow');

async function login() {
  const results = [];
  for (const probe of [probeEccangApi, probeGoodcangApi, probeWinitApi]) {
    try {
      results.push(await probe());
    } catch (error) {
      results.push({ ok: false, error: error.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

async function dryRun(args) {
  const input = args.join('\n');
  const orders = normalizeOrders(input);
  if (!orders.length) throw new Error('Usage: node src/cli.js dry-run PO-...');
  const results = await processOrders(orders, { dryRun: true, allowCreate: false }, {
    onResult: result => console.log(`ROW ${result.stOrderNo}: ${result.status}`)
  });
  console.log(JSON.stringify(results, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'login' || command === 'probe') {
    await login();
    return;
  }
  if (command === 'dry-run') {
    await dryRun(args);
    return;
  }
  console.log('Usage: node src/cli.js <login|probe|dry-run>');
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {});
