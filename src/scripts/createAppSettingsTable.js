// src/scripts/createAppSettingsTable.js
// Usage: node src/scripts/createAppSettingsTable.js
//
// Table `app_settings` (clé/valeur), utilisée par src/routes/adminSite.js
// pour le statut "site fermé"/message. Absente de cette base (confirmé :
// 500 sur GET/PUT /api/admin/site-status). Idempotent (CREATE TABLE IF
// NOT EXISTS) - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(120) PRIMARY KEY,
    setting_value TEXT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "setting_value", sql: "ALTER TABLE app_settings ADD COLUMN setting_value TEXT NULL" },
  { name: "updated_at", sql: "ALTER TABLE app_settings ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "app_settings");
  console.log("[createAppSettingsTable] creating `app_settings`...");
  await pool.query(CREATE_SQL);
  console.log("[createAppSettingsTable] `app_settings` OK");

  if (existed) {
    await ensureColumns(pool, "app_settings", REQUIRED_COLUMNS, "[createAppSettingsTable]");
  }

  await pool.end();
  console.log("[createAppSettingsTable] done");
}

main().catch((e) => {
  console.error("[createAppSettingsTable] FAILED:", e.message || e);
  process.exit(1);
});
