// lib/db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
      charset: 'utf8mb4'
    });
  }
  return pool;
}
console.log('[MYSQL CONNECT]', {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  db: process.env.DB_NAME
});

module.exports = { getPool };
