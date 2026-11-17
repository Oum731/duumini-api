// src/scripts/createAffiliatesTable.js
// Usage: node src/scripts/createAffiliatesTable.js
//
// Table `affiliates`, totalement absente de cette base (confirmé : 500 sur
// GET /api/user/me - "Table 'duuminic_besoin.affiliates' doesn't exist" -
// qui cassait le /me de TOUT utilisateur connecté, pas seulement les
// affiliés, et donnait l'impression que la session "ne restait pas
// vivante" côté front). Colonnes déduites de l'INSERT dans
// src/routes/affiliates.js (module Affiliés complet).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS affiliates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    affiliate_code VARCHAR(40) NOT NULL,
    referral_slug VARCHAR(120) NULL,
    name VARCHAR(255) NULL,
    phone VARCHAR(40) NULL,
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 10,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    total_clicks INT NOT NULL DEFAULT 0,
    total_orders INT NOT NULL DEFAULT 0,
    total_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_affiliates_code (affiliate_code),
    UNIQUE KEY uniq_affiliates_slug (referral_slug),
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_affiliates_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "user_id", sql: "ALTER TABLE affiliates ADD COLUMN user_id BIGINT NULL" },
  { name: "affiliate_code", sql: "ALTER TABLE affiliates ADD COLUMN affiliate_code VARCHAR(40) NOT NULL" },
  { name: "referral_slug", sql: "ALTER TABLE affiliates ADD COLUMN referral_slug VARCHAR(120) NULL" },
  { name: "name", sql: "ALTER TABLE affiliates ADD COLUMN name VARCHAR(255) NULL" },
  { name: "phone", sql: "ALTER TABLE affiliates ADD COLUMN phone VARCHAR(40) NULL" },
  { name: "commission_rate", sql: "ALTER TABLE affiliates ADD COLUMN commission_rate DECIMAL(5,2) NOT NULL DEFAULT 10" },
  { name: "status", sql: "ALTER TABLE affiliates ADD COLUMN status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'" },
  { name: "total_clicks", sql: "ALTER TABLE affiliates ADD COLUMN total_clicks INT NOT NULL DEFAULT 0" },
  { name: "total_orders", sql: "ALTER TABLE affiliates ADD COLUMN total_orders INT NOT NULL DEFAULT 0" },
  { name: "total_earnings", sql: "ALTER TABLE affiliates ADD COLUMN total_earnings DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "notes", sql: "ALTER TABLE affiliates ADD COLUMN notes TEXT NULL" },
  { name: "created_at", sql: "ALTER TABLE affiliates ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE affiliates ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "affiliates");
  console.log("[createAffiliatesTable] creating `affiliates`...");
  await pool.query(CREATE_SQL);
  console.log("[createAffiliatesTable] `affiliates` OK");

  if (existed) {
    await ensureColumns(pool, "affiliates", REQUIRED_COLUMNS, "[createAffiliatesTable]");
  }

  await pool.end();
  console.log("[createAffiliatesTable] done");
}

main().catch((e) => {
  console.error("[createAffiliatesTable] FAILED:", e.message || e);
  process.exit(1);
});
