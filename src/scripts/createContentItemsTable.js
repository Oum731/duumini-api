// src/scripts/createContentItemsTable.js
// Usage: node src/scripts/createContentItemsTable.js
//
// Table `content_items` (src/lib/contentStore.js), jamais créée jusqu'ici.
// Reconstruite de zéro (décision du 2026-11-18) à partir de l'usage réel
// dans le code (upsertDraft/getPublishedBySlug recherchent par
// type+slug+lang).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS content_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(60) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    lang VARCHAR(8) NOT NULL DEFAULT 'fr',
    status ENUM('draft','published') NOT NULL DEFAULT 'draft',
    data_json JSON NULL,
    score DECIMAL(5,2) NULL,
    created_by VARCHAR(60) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,
    UNIQUE KEY uniq_content_items (type, slug, lang),
    INDEX idx_content_items_status (status, published_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "type", sql: "ALTER TABLE content_items ADD COLUMN type VARCHAR(60) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE content_items ADD COLUMN slug VARCHAR(255) NOT NULL" },
  { name: "lang", sql: "ALTER TABLE content_items ADD COLUMN lang VARCHAR(8) NOT NULL DEFAULT 'fr'" },
  { name: "status", sql: "ALTER TABLE content_items ADD COLUMN status ENUM('draft','published') NOT NULL DEFAULT 'draft'" },
  { name: "data_json", sql: "ALTER TABLE content_items ADD COLUMN data_json JSON NULL" },
  { name: "score", sql: "ALTER TABLE content_items ADD COLUMN score DECIMAL(5,2) NULL" },
  { name: "created_by", sql: "ALTER TABLE content_items ADD COLUMN created_by VARCHAR(60) NULL" },
  { name: "created_at", sql: "ALTER TABLE content_items ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE content_items ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
  { name: "published_at", sql: "ALTER TABLE content_items ADD COLUMN published_at TIMESTAMP NULL" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "content_items");
  console.log("[createContentItemsTable] creating `content_items`...");
  await pool.query(CREATE_SQL);
  console.log("[createContentItemsTable] `content_items` OK");

  if (existed) {
    await ensureColumns(pool, "content_items", REQUIRED_COLUMNS, "[createContentItemsTable]");
  }

  await pool.end();
  console.log("[createContentItemsTable] done");
}

main().catch((e) => {
  console.error("[createContentItemsTable] FAILED:", e.message || e);
  process.exit(1);
});
