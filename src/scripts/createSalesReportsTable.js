// src/scripts/createSalesReportsTable.js
// Usage: node src/scripts/createSalesReportsTable.js
//
// Table `sales_reports` (src/services/salesReports.js), jamais créée
// jusqu'ici. Reconstruite de zéro (décision du 2026-11-18).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS sales_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    period_type ENUM('DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
    orders_count INT NOT NULL DEFAULT 0,
    items_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    delivery_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    duumini_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
    details_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_sales_reports (period_type, currency, period_start, period_end)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "period_type", sql: "ALTER TABLE sales_reports ADD COLUMN period_type ENUM('DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL" },
  { name: "period_start", sql: "ALTER TABLE sales_reports ADD COLUMN period_start DATE NOT NULL" },
  { name: "period_end", sql: "ALTER TABLE sales_reports ADD COLUMN period_end DATE NOT NULL" },
  { name: "currency", sql: "ALTER TABLE sales_reports ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MAD'" },
  { name: "orders_count", sql: "ALTER TABLE sales_reports ADD COLUMN orders_count INT NOT NULL DEFAULT 0" },
  { name: "items_amount", sql: "ALTER TABLE sales_reports ADD COLUMN items_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "delivery_amount", sql: "ALTER TABLE sales_reports ADD COLUMN delivery_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "total_amount", sql: "ALTER TABLE sales_reports ADD COLUMN total_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "duumini_commission", sql: "ALTER TABLE sales_reports ADD COLUMN duumini_commission DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "details_json", sql: "ALTER TABLE sales_reports ADD COLUMN details_json JSON NULL" },
  { name: "created_at", sql: "ALTER TABLE sales_reports ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE sales_reports ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "sales_reports");
  console.log("[createSalesReportsTable] creating `sales_reports`...");
  await pool.query(CREATE_SQL);
  console.log("[createSalesReportsTable] `sales_reports` OK");

  if (existed) {
    await ensureColumns(pool, "sales_reports", REQUIRED_COLUMNS, "[createSalesReportsTable]");
  }

  await pool.end();
  console.log("[createSalesReportsTable] done");
}

main().catch((e) => {
  console.error("[createSalesReportsTable] FAILED:", e.message || e);
  process.exit(1);
});
