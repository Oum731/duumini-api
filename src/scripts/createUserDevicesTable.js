// src/scripts/createUserDevicesTable.js
// Usage: node src/scripts/createUserDevicesTable.js
//
// Table `user_devices` (src/routes/devices.js, src/services/notify.js,
// src/routes/products.js - tokens push), jamais créée jusqu'ici.
// Reconstruite de zéro (décision du 2026-11-18). Dépend de `users`.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS user_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    push_token VARCHAR(512) NOT NULL,
    provider VARCHAR(40) NOT NULL DEFAULT 'pushy',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_devices (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_devices_provider (provider)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "user_id", sql: "ALTER TABLE user_devices ADD COLUMN user_id BIGINT NOT NULL" },
  { name: "push_token", sql: "ALTER TABLE user_devices ADD COLUMN push_token VARCHAR(512) NOT NULL" },
  { name: "provider", sql: "ALTER TABLE user_devices ADD COLUMN provider VARCHAR(40) NOT NULL DEFAULT 'pushy'" },
  { name: "created_at", sql: "ALTER TABLE user_devices ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE user_devices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "user_devices");
  console.log("[createUserDevicesTable] creating `user_devices`...");
  await pool.query(CREATE_SQL);
  console.log("[createUserDevicesTable] `user_devices` OK");

  if (existed) {
    await ensureColumns(pool, "user_devices", REQUIRED_COLUMNS, "[createUserDevicesTable]");
  }

  await pool.end();
  console.log("[createUserDevicesTable] done");
}

main().catch((e) => {
  console.error("[createUserDevicesTable] FAILED:", e.message || e);
  process.exit(1);
});
