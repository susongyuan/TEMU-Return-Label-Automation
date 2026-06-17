const { createHmac } = require('crypto');
const { initReturnLabelSchema } = require('./schema');

const MYSQL_DATETIME_FORMAT = '%Y-%m-%d %H:%i:%s';
const TOKEN_VERSION = 1;

function text(value) {
  return String(value || '').trim();
}

function tokenStamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isFinite(time)) return String(time);
  return String(value);
}

function base64UrlJsonDecode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function authSecret() {
  return process.env.DASHBOARD_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.RETURN_DB_PASSWORD ||
    process.env.DB_PASSWORD ||
    process.env.MYSQL_PASSWORD ||
    'temu-dashboard-auth-secret';
}

function signAuthPayload(payloadPart) {
  return createHmac('sha256', authSecret()).update(payloadPart).digest('base64url');
}

function verifyAuthToken(token) {
  const value = text(token);
  if (!value) throw new Error('请先登录');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('登录状态格式异常，请重新登录');
  const [payloadPart, signature] = parts;
  if (signAuthPayload(payloadPart) !== signature) throw new Error('登录状态已失效，请重新登录');
  const payload = base64UrlJsonDecode(payloadPart);
  if (Number(payload.v) !== TOKEN_VERSION) throw new Error('登录状态版本已失效，请重新登录');
  return payload;
}

async function resolveOperator(db, operator = {}) {
  await initReturnLabelSchema(db);
  const tokenPayload = verifyAuthToken(operator.authToken || operator.token);
  const operatorKey = text(tokenPayload.operatorKey);
  if (!operatorKey) throw new Error('请先登录');

  const [rows] = await db.execute(
    `SELECT operator_key, operator_name, password_updated_at, disabled_at,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_key = ?
     LIMIT 1`,
    [operatorKey]
  );
  if (!rows.length) throw new Error('登录账号不存在，请重新登录');
  if (rows[0].disabled_at) throw new Error('账号已停用，请联系管理员');
  if (tokenStamp(rows[0].password_updated_at) !== text(tokenPayload.passwordUpdatedAt)) {
    throw new Error('登录状态已失效，请重新登录');
  }
  await db.execute(
    'UPDATE dashboard_operators SET last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE operator_key = ?',
    [rows[0].operator_key]
  );
  return {
    operatorKey: rows[0].operator_key,
    operatorName: rows[0].operator_name
  };
}

async function resolveOperatorIdentity(db, operator = {}) {
  await initReturnLabelSchema(db);
  const operatorKey = text(operator.operatorKey);
  const operatorName = text(operator.operatorName || operator.name);
  if (text(operator.authToken || operator.token)) return resolveOperator(db, operator);
  if (!operatorKey || !operatorName) throw new Error('请先登录');

  const [rows] = await db.execute(
    `SELECT operator_key, operator_name, disabled_at
     FROM dashboard_operators
     WHERE operator_key = ?
     LIMIT 1`,
    [operatorKey]
  );
  if (!rows.length) throw new Error('登录账号不存在，请重新登录');
  if (rows[0].disabled_at) throw new Error('账号已停用，请联系管理员');
  if (text(rows[0].operator_name) !== operatorName) throw new Error('登录账号不匹配，请重新打开入口');
  await db.execute(
    'UPDATE dashboard_operators SET last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE operator_key = ?',
    [rows[0].operator_key]
  );
  return {
    operatorKey: rows[0].operator_key,
    operatorName: rows[0].operator_name
  };
}

async function resolveOptionalOperator(db, operator = {}) {
  try {
    return await resolveOperatorIdentity(db, operator);
  } catch {
    return {
      operatorKey: null,
      operatorName: text(operator.operatorName || operator.name) || '未登录操作人'
    };
  }
}

module.exports = {
  resolveOperator,
  resolveOperatorIdentity,
  resolveOptionalOperator
};
