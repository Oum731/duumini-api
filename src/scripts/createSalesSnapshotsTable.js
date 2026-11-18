// src/scripts/createSalesSnapshotsTable.js
// Usage: node src/scripts/createSalesSnapshotsTable.js
//
// Table `sales_snapshots` (src/routes/snapshots.js), jamais créée
// jusqu'ici. Reconstruite de zéro (décision du 2026-11-18).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS sales_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    period_type ENUM('MONTH','YEAR') NOT NULL,
    period_key VARCHAR(10) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    orders_done INT NOT NULL DEFAULT 0,
    items_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    delivery_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    duumini_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_sales_snapshots (period_type, period_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "period_type", sql: "ALTER TABLE sales_snapshots ADD COLUMN period_type ENUM('MONTH','YEAR') NOT NULL" },
  { name: "period_key", sql: "ALTER TABLE sales_snapshots ADD COLUMN period_key VARCHAR(10) NOT NULL" },
  { name: "start_date", sql: "ALTER TABLE sales_snapshots ADD COLUMN start_date DATE NOT NULL" },
  { name: "end_date", sql: "ALTER TABLE sales_snapshots ADD COLUMN end_date DATE NOT NULL" },
  { name: "orders_done", sql: "ALTER TABLE sales_snapshots ADD COLUMN orders_done INT NOT NULL DEFAULT 0" },
  { name: "items_amount", sql: "ALTER TABLE sales_snapshots ADD COLUMN items_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "delivery_amount", sql: "ALTER TABLE sales_snapshots ADD COLUMN delivery_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "total_amount", sql: "ALTER TABLE sales_snapshots ADD COLUMN total_amount DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "duumini_commission", sql: "ALTER TABLE sales_snapshots ADD COLUMN duumini_commission DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "created_at", sql: "ALTER TABLE sales_snapshots ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "sales_snapshots");
  console.log("[createSalesSnapshotsTable] creating `sales_snapshots`...");
  await pool.query(CREATE_SQL);
  console.log("[createSalesSnapshotsTable] `sales_snapshots` OK");

  if (existed) {
    await ensureColumns(pool, "sales_snapshots", REQUIRED_COLUMNS, "[createSalesSnapshotsTable]");
  }

  await pool.end();
  console.log("[createSalesSnapshotsTable] done");
}

main().catch((e) => {
  console.error("[createSalesSnapshotsTable] FAILED:", e.message || e);
  process.exit(1);
});
