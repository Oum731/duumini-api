// src/scripts/createAffiliateRevenueReportsTable.js
// Usage: node src/scripts/createAffiliateRevenueReportsTable.js
//
// Table `affiliate_revenue_reports` (src/services/affiliates.js,
// src/routes/affiliates.js), jamais créée jusqu'ici. Reconstruite de zéro
// (décision du 2026-11-18).
//
// Pas de FK sur affiliate_id : `0` est utilisé comme sentinelle "tous
// affiliés confondus" (rapport global), une contrainte FK casserait ces
// lignes.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS affiliate_revenue_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    affiliate_id INT NOT NULL,
    period_type VARCHAR(20) NOT NULL,
    period_key VARCHAR(20) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    clicks_count INT NOT NULL DEFAULT 0,
    orders_count INT NOT NULL DEFAULT 0,
    sales_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_pending DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_approved DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_cancelled DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_affiliate_revenue_reports (affiliate_id, period_type, period_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "affiliate_id", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN affiliate_id INT NOT NULL" },
  { name: "period_type", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN period_type VARCHAR(20) NOT NULL" },
  { name: "period_key", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN period_key VARCHAR(20) NOT NULL" },
  { name: "period_start", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN period_start DATE NOT NULL" },
  { name: "period_end", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN period_end DATE NOT NULL" },
  { name: "clicks_count", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN clicks_count INT NOT NULL DEFAULT 0" },
  { name: "orders_count", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN orders_count INT NOT NULL DEFAULT 0" },
  { name: "sales_amount", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN sales_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_pending", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN commission_pending DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_approved", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN commission_approved DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_paid", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN commission_paid DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_cancelled", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN commission_cancelled DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "commission_total", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN commission_total DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "currency", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MAD'" },
  { name: "created_at", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE affiliate_revenue_reports ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "affiliate_revenue_reports");
  console.log("[createAffiliateRevenueReportsTable] creating `affiliate_revenue_reports`...");
  await pool.query(CREATE_SQL);
  console.log("[createAffiliateRevenueReportsTable] `affiliate_revenue_reports` OK");

  if (existed) {
    await ensureColumns(pool, "affiliate_revenue_reports", REQUIRED_COLUMNS, "[createAffiliateRevenueReportsTable]");
  }

  await pool.end();
  console.log("[createAffiliateRevenueReportsTable] done");
}

main().catch((e) => {
  console.error("[createAffiliateRevenueReportsTable] FAILED:", e.message || e);
  process.exit(1);
});
