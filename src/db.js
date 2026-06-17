const fs = require('fs');
const mysql = require('mysql2/promise');
const { loadEnv } = require('./env');

const DEFAULT_CREDENTIALS_FILE = 'C:\\mysql\\mysql-local-credentials.txt';

let pool = null;

function readLocalMysqlCredentials(file = process.env.DB_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE) {
  if (!file || !fs.existsSync(file)) return {};

  const config = {};
  let section = '';
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^root admin:/i.test(line)) {
      section = 'root';
      continue;
    }
    if (/^application database:/i.test(line)) {
      section = 'application';
      continue;
    }

    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();

    if (key === 'host') config.host = value;
    if (key === 'port') config.port = value;
    if (section === 'application' && key === 'database') config.database = value;
    if (section === 'application' && key === 'user') config.user = value;
    if (section === 'application' && key === 'password') config.password = value;
  }
  return config;
}

function getDbConfig() {
  loadEnv();
  const fileConfig = readLocalMysqlCredentials();
  return {
    host: process.env.RETURN_DB_HOST || process.env.DB_HOST || process.env.MYSQL_HOST || fileConfig.host || '127.0.0.1',
    port: Number(process.env.RETURN_DB_PORT || process.env.DB_PORT || process.env.MYSQL_PORT || fileConfig.port || 3306),
    user: process.env.RETURN_DB_USER || process.env.DB_USER || process.env.MYSQL_USER || fileConfig.user || 'temu_app',
    password: process.env.RETURN_DB_PASSWORD || process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || fileConfig.password || '',
    database: process.env.RETURN_DB_NAME || process.env.DB_NAME || process.env.MYSQL_DATABASE || fileConfig.database || 'temu_monitor',
    waitForConnections: true,
    connectionLimit: Number(process.env.RETURN_DB_CONNECTION_LIMIT || process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: process.env.DB_TIMEZONE || '+08:00',
    supportBigNumbers: true,
    bigNumberStrings: true
  };
}

function redactedDbConfig() {
  const config = getDbConfig();
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database
  };
}

function getPool() {
  if (!pool) pool = mysql.createPool(getDbConfig());
  return pool;
}

async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = {
  closePool,
  getDbConfig,
  getPool,
  redactedDbConfig
};
