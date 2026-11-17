// src/scripts/_schemaUtils.js
// Utilitaires partagés par les scripts de migration : CREATE TABLE IF NOT
// EXISTS ne fait rien si la table existe déjà (cas fréquent ici - tables
// créées à la main sur l'ancienne base Hostinger, avec un schéma parfois
// incomplet). ensureColumns() vérifie et complète les colonnes manquantes
// après coup, pour qu'un script reste correct même quand la table
// préexistait déjà sous une forme partielle.

async function tableExists(pool, table) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

// columns: [{ name, sql }] - sql est l'ALTER TABLE complet à exécuter si la
// colonne `name` n'existe pas déjà sur `table`.
async function ensureColumns(pool, table, columns, log) {
  const prefix = log || "[ensureColumns]";
  for (const { name, sql } of columns) {
    if (await columnExists(pool, table, name)) continue;
    console.log(`${prefix} \`${table}\`.${name} manquante, ajout...`);
    await pool.query(sql);
    console.log(`${prefix} \`${table}\`.${name} OK`);
  }
}

module.exports = { tableExists, columnExists, ensureColumns };
