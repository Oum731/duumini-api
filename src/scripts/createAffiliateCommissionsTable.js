// src/scripts/createAffiliateCommissionsTable.js
// Usage: node src/scripts/createAffiliateCommissionsTable.js
//
// Table `affiliate_commissions` (src/services/affiliates.js,
// src/routes/affiliates.js, src/routes/affiliate_me.js), jamais créée
// jusqu'ici. Reconstruite de zéro (décision du 2026-11-18). Dépend de
// `affiliates` et `orders` (doivent être créées avant).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS affiliate_commissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    affiliate_id INT NOT NULL,
    order_id BIGINT NOT NULL,
    order_item_id INT NULL,
    affiliate_code VARCHAR(40) NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_rate DECIMAL(5,2) NULL,
    base_amount DECIMAL(12,2) NULL,
    product_id BIGINT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
    status ENUM('PENDING','APPROVED','PAID','CANCELLED') NOT NULL DEFAULT 'PENDING',
    period_day DATE NULL,
    period_week_start DATE NULL,
    period_month VARCHAR(7) NULL,
    period_year INT NULL,
    source VARCHAR(60) NULL,
    note VARCHAR(500) NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    INDEX idx_affiliate_commissions_affiliate (affiliate_id),
    INDEX idx_affiliate_commissions_order (order_id, order_item_id),
    INDEX idx_affiliate_commissions_period (period_day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "affiliate_id", sql: "ALTER TABLE affiliate_commissions ADD COLUMN affiliate_id INT NOT NULL" },
  { name: "order_id", sql: "ALTER TABLE affiliate_commissions ADD COLUMN order_id BIGINT NOT NULL" },
  { name: "order_item_id", sql: "ALTER TABLE affiliate_commissions ADD COLUMN order_item_id INT NULL" },
  { name: "affiliate_code", sql: "ALTER TABLE affiliate_commissions ADD COLUMN affiliate_code VARCHAR(40) NULL" },
  { name: "amount", sql: "ALTER TABLE affiliate_commissions ADD COLUMN amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_rate", sql: "ALTER TABLE affiliate_commissions ADD COLUMN commission_rate DECIMAL(5,2) NULL" },
  { name: "base_amount", sql: "ALTER TABLE affiliate_commissions ADD COLUMN base_amount DECIMAL(12,2) NULL" },
  { name: "product_id", sql: "ALTER TABLE affiliate_commissions ADD COLUMN product_id BIGINT NULL" },
  { name: "currency", sql: "ALTER TABLE affiliate_commissions ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MAD'" },
  { name: "status", sql: "ALTER TABLE affiliate_commissions ADD COLUMN status ENUM('PENDING','APPROVED','PAID','CANCELLED') NOT NULL DEFAULT 'PENDING'" },
  { name: "period_day", sql: "ALTER TABLE affiliate_commissions ADD COLUMN period_day DATE NULL" },
  { name: "period_week_start", sql: "ALTER TABLE affiliate_commissions ADD COLUMN period_week_start DATE NULL" },
  { name: "period_month", sql: "ALTER TABLE affiliate_commissions ADD COLUMN period_month VARCHAR(7) NULL" },
  { name: "period_year", sql: "ALTER TABLE affiliate_commissions ADD COLUMN period_year INT NULL" },
  { name: "source", sql: "ALTER TABLE affiliate_commissions ADD COLUMN source VARCHAR(60) NULL" },
  { name: "note", sql: "ALTER TABLE affiliate_commissions ADD COLUMN note VARCHAR(500) NULL" },
  { name: "created_at", sql: "ALTER TABLE affiliate_commissions ADD COLUMN created_at TIMESTAMP NULL" },
  { name: "updated_at", sql: "ALTER TABLE affiliate_commissions ADD COLUMN updated_at TIMESTAMP NULL" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "affiliate_commissions");
  console.log("[createAffiliateCommissionsTable] creating `affiliate_commissions`...");
  await pool.query(CREATE_SQL);
  console.log("[createAffiliateCommissionsTable] `affiliate_commissions` OK");

  if (existed) {
    await ensureColumns(pool, "affiliate_commissions", REQUIRED_COLUMNS, "[createAffiliateCommissionsTable]");
  }

  await pool.end();
  console.log("[createAffiliateCommissionsTable] done");
}

main().catch((e) => {
  console.error("[createAffiliateCommissionsTable] FAILED:", e.message || e);
  process.exit(1);
});
