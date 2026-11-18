// src/scripts/createPageCopyVersionsTable.js
// Usage: node src/scripts/createPageCopyVersionsTable.js
//
// Table `page_copy_versions` (src/routes/pageCopy.js), jamais créée
// jusqu'ici. Reconstruite de zéro (décision du 2026-11-18). Dépend de
// `page_copy` (doit être créée avant).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS page_copy_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    page_copy_id INT NOT NULL,
    slug VARCHAR(255) NOT NULL,
    lang VARCHAR(8) NOT NULL DEFAULT 'fr',
    data_json JSON NULL,
    reason VARCHAR(255) NULL,
    created_by VARCHAR(60) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (page_copy_id) REFERENCES page_copy(id) ON DELETE CASCADE,
    INDEX idx_page_copy_versions_page (page_copy_id),
    INDEX idx_page_copy_versions_slug (slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "page_copy_id", sql: "ALTER TABLE page_copy_versions ADD COLUMN page_copy_id INT NOT NULL" },
  { name: "slug", sql: "ALTER TABLE page_copy_versions ADD COLUMN slug VARCHAR(255) NOT NULL" },
  { name: "lang", sql: "ALTER TABLE page_copy_versions ADD COLUMN lang VARCHAR(8) NOT NULL DEFAULT 'fr'" },
  { name: "data_json", sql: "ALTER TABLE page_copy_versions ADD COLUMN data_json JSON NULL" },
  { name: "reason", sql: "ALTER TABLE page_copy_versions ADD COLUMN reason VARCHAR(255) NULL" },
  { name: "created_by", sql: "ALTER TABLE page_copy_versions ADD COLUMN created_by VARCHAR(60) NOT NULL DEFAULT 'admin'" },
  { name: "created_at", sql: "ALTER TABLE page_copy_versions ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "page_copy_versions");
  console.log("[createPageCopyVersionsTable] creating `page_copy_versions`...");
  await pool.query(CREATE_SQL);
  console.log("[createPageCopyVersionsTable] `page_copy_versions` OK");

  if (existed) {
    await ensureColumns(pool, "page_copy_versions", REQUIRED_COLUMNS, "[createPageCopyVersionsTable]");
  }

  await pool.end();
  console.log("[createPageCopyVersionsTable] done");
}

main().catch((e) => {
  console.error("[createPageCopyVersionsTable] FAILED:", e.message || e);
  process.exit(1);
});
