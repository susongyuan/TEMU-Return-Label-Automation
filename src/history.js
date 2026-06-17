const { getPool } = require('./db');
const { initReturnLabelSchema } = require('./schema');
const { resolveOptionalOperator } = require('./operator-auth');
const crypto = require('crypto');

function text(value) {
  return String(value || '').trim();
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ').trim();
  } catch {
    return String(value).replace(/\s+/g, ' ').trim();
  }
}

function normalizePlatform(value) {
  const valueText = compactText(value);
  if (!valueText) return '';
  if (/goodcang|gucang|谷仓/i.test(valueText)) return 'goodcang';
  if (/winit|万邑通/i.test(valueText)) return 'winit';
  if (/4px/i.test(valueText)) return '4px';
  return valueText.toLowerCase();
}

function platformLabel(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'goodcang') return '谷仓';
  if (normalized === 'winit') return '万邑通';
  if (normalized === '4px') return '4PX';
  return platform || '未知';
}

function getPlatform(row = {}) {
  return normalizePlatform(firstValue(
    row.platform,
    row.warehousePlatform,
    row.warehouseSource,
    row.returnCreation?.platform,
    row.warehouseOrder?.platform,
    row.warehouseOrder?.source,
    row.eccang?.platform,
    row.eccang?.warehouse,
    row.selectedLogistics?.platform
  ));
}

function getReturnOrderNo(row = {}) {
  const creation = row.returnCreation || {};
  return firstValue(row.returnOrderNo, creation.returnOrderNo, creation.orderNo, creation.id);
}

function getLabelNo(row = {}) {
  const creation = row.returnCreation || {};
  return firstValue(
    row.labelNo,
    row.waybillNo,
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

function getTrackingNo(row = {}) {
  const creation = row.returnCreation || {};
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  return firstValue(
    row.trackingNo,
    row.trackNo,
    creation.trackingNo,
    creation.trackNo,
    eccang.trackingNo,
    warehouse.trackingNo,
    asArray(warehouse.trackingNumbers)[0]
  );
}

function getCustomerReturnTrackingNo(row = {}) {
  const creation = row.returnCreation || {};
  const preview = creation.createPayloadPreview || {};
  return firstValue(row.customerReturnTrackingNo, row.returnExpressNo, row.returnTrackingNo, creation.customerReturnTrackingNo, preview.expressNo, '');
}

function getCustomerReturnCarrierName(row = {}) {
  const creation = row.returnCreation || {};
  const preview = creation.createPayloadPreview || {};
  return firstValue(
    row.customerReturnCarrierName,
    row.returnCarrierName,
    row.preferredReturnCourier,
    row.returnCourier,
    row.courier,
    row.supplierName,
    row.returnSupplierName,
    creation.customerReturnCarrierName,
    preview.supplierName,
    preview.courier,
    ''
  );
}

function getReturnLogisticsMode(row = {}) {
  const creation = row.returnCreation || {};
  const explicit = text(firstValue(row.returnLogisticsMode, creation.returnLogisticsMode, '')).toLowerCase();
  if (['custom', 'self', 'manual', '自选', '自寄'].includes(explicit)) return 'custom';
  if (['auto', 'platform', 'official', '平台', '官方', '代选'].includes(explicit)) return 'auto';
  return getCustomerReturnTrackingNo(row) || getCustomerReturnCarrierName(row) ? 'custom' : 'auto';
}

function getWarehouseSource(row = {}) {
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  return platformLabel(firstValue(
    row.warehouseSource,
    row.warehousePlatform,
    row.platform,
    warehouse.source,
    warehouse.platform,
    eccang.source,
    eccang.platform
  ));
}

function getWarehouseOrderNo(row = {}) {
  const warehouse = row.warehouseOrder || {};
  const eccang = row.eccang || {};
  return firstValue(
    row.warehouseOrderNo,
    warehouse.warehouseOrderNo,
    warehouse.orderNo,
    warehouse.id,
    eccang.warehouseOrderNo,
    eccang.orderNo
  );
}

function getSelectedLogistics(row = {}) {
  const creation = row.returnCreation || {};
  const selected = firstValue(row.selectedLogistics, row.cheapestLogistics, creation.selectedLogistics, creation.cheapestLogistics);
  if (!selected || typeof selected !== 'object') return null;
  return {
    code: firstValue(selected.code, selected.channelCode, selected.serviceCode),
    name: firstValue(selected.name, selected.channelName, selected.logisticsName, selected.serviceName, selected.shippingMethod, selected.provider),
    price: firstValue(selected.price, selected.fee, selected.amount, selected.cost, selected.totalFee),
    currency: firstValue(selected.currency, selected.currencyCode, 'CNY')
  };
}

function getLabelDownload(row = {}) {
  const creation = row.returnCreation || {};
  const file = firstValue(row.labelFile, creation.labelFile);
  return firstValue(
    row.labelDownloadUrl,
    row.downloadUrl,
    file?.downloadUrl,
    creation.labelDownloadUrl,
    creation.downloadUrl,
    creation.labelFile?.downloadUrl
  );
}

function deriveDisplayStatus(row = {}) {
  const key = text(row.status).toLowerCase();
  const creation = row.returnCreation || {};
  if (['needs-review', 'review', 'skipped'].includes(key)) return key;
  if (creation.dryRun || (key === 'done' && !getReturnOrderNo(row) && !getLabelNo(row))) return 'dry-run';
  if (key === 'done' && (getReturnOrderNo(row) || getLabelNo(row))) return 'created';
  return row.displayStatus || row.status || '';
}

function messageFromRow(row = {}) {
  const steps = asArray(row.steps);
  const lastStep = steps[steps.length - 1];
  return firstValue(row.error, row.message, row.returnCreation?.message, lastStep?.message, '');
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20);
}

function buildHistoryPayload(job = {}, row = {}, index = 0) {
  const platform = getPlatform(row);
  return {
    externalId: hashId([job.id, job.createdAt, row.rawOrderNo, row.stOrderNo, getReturnOrderNo(row), index].join('|')),
    jobId: job.id,
    rawOrderNo: row.rawOrderNo || '',
    stOrderNo: row.stOrderNo || '',
    orderNo: firstValue(row.orderNo, row.stOrderNo, row.rawOrderNo, ''),
    trackingNo: getTrackingNo(row) || '',
    platform,
    platformLabel: platformLabel(platform),
    warehouseSource: getWarehouseSource(row),
    warehouseOrderNo: getWarehouseOrderNo(row),
    returnLogisticsMode: getReturnLogisticsMode(row),
    customerReturnTrackingNo: getCustomerReturnTrackingNo(row),
    customerReturnCarrierName: getCustomerReturnCarrierName(row),
    returnOrderNo: getReturnOrderNo(row) || '',
    labelNo: getLabelNo(row) || '',
    labelDownloadUrl: getLabelDownload(row) || '',
    status: row.status || '',
    displayStatus: deriveDisplayStatus(row),
    message: messageFromRow(row),
    selectedLogisticsJson: getSelectedLogistics(row),
    stepsJson: asArray(row.steps).slice(-80),
    responseJson: row
  };
}

function normalizePayload(body = {}) {
  return {
    externalId: text(body.externalId || body.external_id),
    jobId: text(body.jobId || body.job_id),
    rawOrderNo: text(body.rawOrderNo || body.raw_order_no),
    stOrderNo: text(body.stOrderNo || body.st_order_no),
    orderNo: text(body.orderNo || body.order_no),
    trackingNo: text(body.trackingNo || body.tracking_no),
    platform: text(body.platform),
    platformLabel: text(body.platformLabel || body.platform_label),
    storeName: text(body.storeName || body.store_name),
    warehouseSource: text(body.warehouseSource || body.warehouse_source),
    warehouseOrderNo: text(body.warehouseOrderNo || body.warehouse_order_no),
    returnLogisticsMode: text(body.returnLogisticsMode || body.return_logistics_mode),
    customerReturnTrackingNo: text(body.customerReturnTrackingNo || body.customer_return_tracking_no),
    customerReturnCarrierName: text(body.customerReturnCarrierName || body.customer_return_carrier_name),
    returnOrderNo: text(body.returnOrderNo || body.return_order_no),
    labelNo: text(body.labelNo || body.label_no),
    labelDownloadUrl: text(body.labelDownloadUrl || body.label_download_url),
    status: text(body.status) || 'pending',
    displayStatus: text(body.displayStatus || body.display_status),
    message: text(body.message),
    selectedLogisticsJson: body.selectedLogisticsJson ?? body.selected_logistics_json ?? null,
    stepsJson: body.stepsJson ?? body.steps_json ?? null,
    requestJson: body.requestJson ?? body.request_json ?? null,
    responseJson: body.responseJson ?? body.response_json ?? null
  };
}

function serializableJson(value) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function appendReturnLabelHistory({ body = {}, operator = {}, status = 'pending' } = {}) {
  const pool = getPool();
  await initReturnLabelSchema(pool);
  const resolvedOperator = await resolveOptionalOperator(pool, operator);
  const payload = normalizePayload({ ...body, status });
  const [result] = await pool.execute(
    `INSERT INTO return_label_history (
      external_id, job_id, raw_order_no, st_order_no, order_no, tracking_no,
      platform, platform_label, store_name, warehouse_source, warehouse_order_no,
      return_logistics_mode, customer_return_tracking_no, customer_return_carrier_name,
      return_order_no, label_no, label_download_url,
      status, display_status, message,
      selected_logistics_json, steps_json, request_json, response_json,
      operator_key, operator_name, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      job_id = VALUES(job_id),
      raw_order_no = VALUES(raw_order_no),
      st_order_no = VALUES(st_order_no),
      order_no = VALUES(order_no),
      tracking_no = VALUES(tracking_no),
      platform = VALUES(platform),
      platform_label = VALUES(platform_label),
      store_name = VALUES(store_name),
      warehouse_source = VALUES(warehouse_source),
      warehouse_order_no = VALUES(warehouse_order_no),
      return_logistics_mode = VALUES(return_logistics_mode),
      customer_return_tracking_no = VALUES(customer_return_tracking_no),
      customer_return_carrier_name = VALUES(customer_return_carrier_name),
      return_order_no = VALUES(return_order_no),
      label_no = VALUES(label_no),
      label_download_url = VALUES(label_download_url),
      status = VALUES(status),
      display_status = VALUES(display_status),
      message = VALUES(message),
      selected_logistics_json = VALUES(selected_logistics_json),
      steps_json = VALUES(steps_json),
      request_json = VALUES(request_json),
      response_json = VALUES(response_json),
      operator_key = VALUES(operator_key),
      operator_name = VALUES(operator_name),
      source = VALUES(source)`,
    [
      payload.externalId || null,
      payload.jobId || null,
      payload.rawOrderNo || null,
      payload.stOrderNo || null,
      payload.orderNo || null,
      payload.trackingNo || null,
      payload.platform || null,
      payload.platformLabel || null,
      payload.storeName || null,
      payload.warehouseSource || null,
      payload.warehouseOrderNo || null,
      payload.returnLogisticsMode || null,
      payload.customerReturnTrackingNo || null,
      payload.customerReturnCarrierName || null,
      payload.returnOrderNo || null,
      payload.labelNo || null,
      payload.labelDownloadUrl || null,
      payload.status,
      payload.displayStatus || null,
      payload.message || null,
      serializableJson(payload.selectedLogisticsJson),
      serializableJson(payload.stepsJson),
      serializableJson(payload.requestJson),
      serializableJson(payload.responseJson),
      resolvedOperator.operatorKey || null,
      resolvedOperator.operatorName || null,
      'return-label-automation'
    ]
  );

  return {
    id: result.insertId || null,
    ...payload,
    operatorKey: resolvedOperator.operatorKey || null,
    operatorName: resolvedOperator.operatorName || null
  };
}

async function saveJobHistory(job = {}) {
  const rows = asArray(job.results);
  if (!rows.length) return [];

  const saved = [];
  for (const [index, row] of rows.entries()) {
    const payload = buildHistoryPayload(job, row, index);
    saved.push(await appendReturnLabelHistory({
      body: payload,
      operator: job.operator || {},
      status: payload.status
    }));
  }
  return saved;
}

async function listReturnLabelHistory(options = {}) {
  const pool = getPool();
  await initReturnLabelSchema(pool);
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const platformKey = normalizePlatform(options.platform || 'all');
  const statusKey = text(options.status).toLowerCase();
  const keyword = compactText(options.keyword).toLowerCase();
  const where = [];
  const params = [];
  if (platformKey && platformKey !== 'all') {
    where.push('platform = ?');
    params.push(platformKey);
  }
  if (statusKey) {
    where.push('LOWER(COALESCE(display_status, status)) = ?');
    params.push(statusKey);
  }
  if (keyword) {
    where.push(`LOWER(CONCAT_WS(' ',
      raw_order_no, st_order_no, order_no, tracking_no,
      warehouse_order_no, return_order_no, label_no, message
    )) LIKE ?`);
    params.push(`%${keyword}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM return_label_history ${whereSql}`, params);
  const [rows] = await pool.execute(
    `SELECT
      id,
      external_id AS externalId,
      job_id AS jobId,
      raw_order_no AS rawOrderNo,
      st_order_no AS stOrderNo,
      order_no AS orderNo,
      tracking_no AS trackingNo,
      platform,
      platform_label AS platformLabel,
      store_name AS storeName,
      warehouse_source AS warehouseSource,
      warehouse_order_no AS warehouseOrderNo,
      return_logistics_mode AS returnLogisticsMode,
      customer_return_tracking_no AS customerReturnTrackingNo,
      customer_return_carrier_name AS customerReturnCarrierName,
      return_order_no AS returnOrderNo,
      label_no AS labelNo,
      label_download_url AS labelDownloadUrl,
      status,
      display_status AS displayStatus,
      message,
      CAST(selected_logistics_json AS CHAR) AS selectedLogisticsJson,
      CAST(steps_json AS CHAR) AS stepsJson,
      CAST(request_json AS CHAR) AS requestJson,
      CAST(response_json AS CHAR) AS responseJson,
      operator_key AS operatorKey,
      operator_name AS operatorName,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS createdAt,
      DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
     FROM return_label_history
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`,
    params
  );
  const items = rows.map(row => ({
    ...row,
    selectedLogisticsJson: parseJson(row.selectedLogisticsJson),
    stepsJson: parseJson(row.stepsJson),
    requestJson: parseJson(row.requestJson),
    responseJson: parseJson(row.responseJson)
  }));
  return {
    items,
    total: Number(countRows[0]?.total || items.length),
    platform: platformKey || 'all'
  };
}

async function getHistoryRecord(id) {
  const pool = getPool();
  await initReturnLabelSchema(pool);
  const [rows] = await pool.execute(
    `SELECT
      id,
      external_id AS externalId,
      job_id AS jobId,
      raw_order_no AS rawOrderNo,
      st_order_no AS stOrderNo,
      order_no AS orderNo,
      tracking_no AS trackingNo,
      platform,
      platform_label AS platformLabel,
      store_name AS storeName,
      warehouse_source AS warehouseSource,
      warehouse_order_no AS warehouseOrderNo,
      return_logistics_mode AS returnLogisticsMode,
      customer_return_tracking_no AS customerReturnTrackingNo,
      customer_return_carrier_name AS customerReturnCarrierName,
      return_order_no AS returnOrderNo,
      label_no AS labelNo,
      label_download_url AS labelDownloadUrl,
      status,
      display_status AS displayStatus,
      message,
      CAST(selected_logistics_json AS CHAR) AS selectedLogisticsJson,
      CAST(steps_json AS CHAR) AS stepsJson,
      CAST(request_json AS CHAR) AS requestJson,
      CAST(response_json AS CHAR) AS responseJson,
      operator_key AS operatorKey,
      operator_name AS operatorName,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS createdAt,
      DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
     FROM return_label_history
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    ...row,
    selectedLogisticsJson: parseJson(row.selectedLogisticsJson),
    stepsJson: parseJson(row.stepsJson),
    requestJson: parseJson(row.requestJson),
    responseJson: parseJson(row.responseJson)
  };
}

async function deleteHistoryRecord(id) {
  const pool = getPool();
  await initReturnLabelSchema(pool);
  const [result] = await pool.execute('DELETE FROM return_label_history WHERE id = ?', [id]);
  return Boolean(result.affectedRows);
}

module.exports = {
  appendReturnLabelHistory,
  deleteHistoryRecord,
  getHistoryRecord,
  listHistory: listReturnLabelHistory,
  listReturnLabelHistory,
  saveJobHistory
};
