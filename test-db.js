// test-db.js
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    const [rows] = await conn.query('SELECT 1 AS ok');
    console.log('MySQL OK:', rows[0]);
    await conn.end();
  } catch (e) {
    console.error('MySQL ERROR:', e.message);
  }
})();
