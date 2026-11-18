// src/scripts/createPageCopyTable.js
// Usage: node src/scripts/createPageCopyTable.js
//
// Table `page_copy` (src/routes/pageCopy.js), jamais créée jusqu'ici.
// Reconstruite de zéro (décision du 2026-11-18).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS page_copy (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(255) NOT NULL,
    lang VARCHAR(8) NOT NULL DEFAULT 'fr',
    data_json JSON NULL,
    published_at TIMESTAMP NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_page_copy (slug, lang)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "slug", sql: "ALTER TABLE page_copy ADD COLUMN slug VARCHAR(255) NOT NULL" },
  { name: "lang", sql: "ALTER TABLE page_copy ADD COLUMN lang VARCHAR(8) NOT NULL DEFAULT 'fr'" },
  { name: "data_json", sql: "ALTER TABLE page_copy ADD COLUMN data_json JSON NULL" },
  { name: "published_at", sql: "ALTER TABLE page_copy ADD COLUMN published_at TIMESTAMP NULL" },
  { name: "updated_at", sql: "ALTER TABLE page_copy ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "page_copy");
  console.log("[createPageCopyTable] creating `page_copy`...");
  await pool.query(CREATE_SQL);
  console.log("[createPageCopyTable] `page_copy` OK");

  if (existed) {
    await ensureColumns(pool, "page_copy", REQUIRED_COLUMNS, "[createPageCopyTable]");
  }

  await pool.end();
  console.log("[createPageCopyTable] done");
}

main().catch((e) => {
  console.error("[createPageCopyTable] FAILED:", e.message || e);
  process.exit(1);
});
