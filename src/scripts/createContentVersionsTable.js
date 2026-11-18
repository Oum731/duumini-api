// src/scripts/createContentVersionsTable.js
// Usage: node src/scripts/createContentVersionsTable.js
//
// Table `content_versions` (src/lib/contentStore.js), jamais créée
// jusqu'ici. Reconstruite de zéro (décision du 2026-11-18). Dépend de
// `content_items` (doit être créée avant).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS content_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    content_item_id INT NOT NULL,
    data_json JSON NULL,
    score_before DECIMAL(5,2) NULL,
    score_after DECIMAL(5,2) NULL,
    reason VARCHAR(120) NULL,
    created_by VARCHAR(60) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
    INDEX idx_content_versions_item (content_item_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "content_item_id", sql: "ALTER TABLE content_versions ADD COLUMN content_item_id INT NOT NULL" },
  { name: "data_json", sql: "ALTER TABLE content_versions ADD COLUMN data_json JSON NULL" },
  { name: "score_before", sql: "ALTER TABLE content_versions ADD COLUMN score_before DECIMAL(5,2) NULL" },
  { name: "score_after", sql: "ALTER TABLE content_versions ADD COLUMN score_after DECIMAL(5,2) NULL" },
  { name: "reason", sql: "ALTER TABLE content_versions ADD COLUMN reason VARCHAR(120) NULL" },
  { name: "created_by", sql: "ALTER TABLE content_versions ADD COLUMN created_by VARCHAR(60) NULL" },
  { name: "created_at", sql: "ALTER TABLE content_versions ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "content_versions");
  console.log("[createContentVersionsTable] creating `content_versions`...");
  await pool.query(CREATE_SQL);
  console.log("[createContentVersionsTable] `content_versions` OK");

  if (existed) {
    await ensureColumns(pool, "content_versions", REQUIRED_COLUMNS, "[createContentVersionsTable]");
  }

  await pool.end();
  console.log("[createContentVersionsTable] done");
}

main().catch((e) => {
  console.error("[createContentVersionsTable] FAILED:", e.message || e);
  process.exit(1);
});
