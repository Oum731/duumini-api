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
      // Force la résolution IPv4 : certains hébergeurs (Render notamment)
      // n'ont pas de route IPv6 vers l'hôte MySQL, ce qui fait échouer une
      // tentative de connexion sur l'enregistrement AAAA avant même
      // d'essayer l'IPv4 — inutile si le serveur MySQL n'écoute qu'en IPv4.
      family: 4,
    });
  }
  return pool;
}

module.exports = { getPool };
