const mysql = require('mysql2/promise');
require('dotenv').config();
const { env } = require('./env');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
      charset: 'utf8mb4',
      ssl: env.MYSQL_SSL ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

module.exports = { getPool };
