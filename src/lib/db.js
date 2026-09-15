const mysql = require('mysql2/promise');
const dns = require('dns');
require('dotenv').config();
const { env } = require('./env');

// Certains hébergeurs (Render notamment) n'ont pas de route IPv6 vers l'hôte
// MySQL : Node tente alors l'enregistrement AAAA en premier, ce qui échoue
// (ENETUNREACH) avant même d'essayer l'IPv4 qui, lui, fonctionne. `family: 4`
// n'est PAS une option reconnue par mysql2 (silencieusement ignorée avec un
// warning) ; la bonne façon de forcer la résolution IPv4 est de changer
// l'ordre de résolution DNS par défaut de Node lui-même.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 16.4 : pas grave, on retombe sur le comportement par défaut.
}

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
