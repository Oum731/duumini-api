// src/scripts/createAffiliateClicksTable.js
// Usage: node src/scripts/createAffiliateClicksTable.js
//
// Table `affiliate_clicks` (tracking des clics sur les liens d'affiliés),
// totalement absente de cette base (confirmé : 500 "Table
// 'duuminic_besoin.affiliate_clicks' doesn't exist" sur
// /api/affiliates/reports/summary). Colonnes déduites de
// insertAffiliateClick() dans src/routes/affiliates.js, qui détecte déjà
// dynamiquement les colonnes présentes - on les crée toutes d'un coup
// pour que ce feature-detection trouve tout dès le départ.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    affiliate_id INT NOT NULL,
    affiliate_code VARCHAR(40) NULL,
    product_id BIGINT NULL,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(512) NULL,
    referer_url VARCHAR(1024) NULL,
    landing_url VARCHAR(1024) NULL,
    source VARCHAR(60) NULL,
    device VARCHAR(60) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE,
    INDEX idx_affiliate_clicks_affiliate (affiliate_id),
    INDEX idx_affiliate_clicks_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "affiliate_id", sql: "ALTER TABLE affiliate_clicks ADD COLUMN affiliate_id INT NOT NULL" },
  { name: "affiliate_code", sql: "ALTER TABLE affiliate_clicks ADD COLUMN affiliate_code VARCHAR(40) NULL" },
  { name: "product_id", sql: "ALTER TABLE affiliate_clicks ADD COLUMN product_id BIGINT NULL" },
  { name: "ip_address", sql: "ALTER TABLE affiliate_clicks ADD COLUMN ip_address VARCHAR(64) NULL" },
  { name: "user_agent", sql: "ALTER TABLE affiliate_clicks ADD COLUMN user_agent VARCHAR(512) NULL" },
  { name: "referer_url", sql: "ALTER TABLE affiliate_clicks ADD COLUMN referer_url VARCHAR(1024) NULL" },
  { name: "landing_url", sql: "ALTER TABLE affiliate_clicks ADD COLUMN landing_url VARCHAR(1024) NULL" },
  { name: "source", sql: "ALTER TABLE affiliate_clicks ADD COLUMN source VARCHAR(60) NULL" },
  { name: "device", sql: "ALTER TABLE affiliate_clicks ADD COLUMN device VARCHAR(60) NULL" },
  { name: "created_at", sql: "ALTER TABLE affiliate_clicks ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "affiliate_clicks");
  console.log("[createAffiliateClicksTable] creating `affiliate_clicks`...");
  await pool.query(CREATE_SQL);
  console.log("[createAffiliateClicksTable] `affiliate_clicks` OK");

  if (existed) {
    await ensureColumns(pool, "affiliate_clicks", REQUIRED_COLUMNS, "[createAffiliateClicksTable]");
  }

  await pool.end();
  console.log("[createAffiliateClicksTable] done");
}

main().catch((e) => {
  console.error("[createAffiliateClicksTable] FAILED:", e.message || e);
  process.exit(1);
});
