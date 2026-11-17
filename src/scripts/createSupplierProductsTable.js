// src/scripts/createSupplierProductsTable.js
// Usage: node src/scripts/createSupplierProductsTable.js
//
// Table `supplier_products`, utilisée par src/routes/supplier_products.js.
// Absente de cet environnement (créée à la main sur l'ancienne base de
// production, jamais versionnée). Idempotent - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS supplier_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_shop_id BIGINT NOT NULL,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NULL,
    description TEXT NULL,
    unit VARCHAR(60) NULL,
    stock_qty INT NOT NULL DEFAULT 0,
    price_wholesale DECIMAL(12,2) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_shop_id) REFERENCES shops(id),
    INDEX idx_supplier_products_shop (supplier_shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "supplier_shop_id", sql: "ALTER TABLE supplier_products ADD COLUMN supplier_shop_id BIGINT NOT NULL" },
  { name: "title", sql: "ALTER TABLE supplier_products ADD COLUMN title VARCHAR(255) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE supplier_products ADD COLUMN slug VARCHAR(255) NULL" },
  { name: "description", sql: "ALTER TABLE supplier_products ADD COLUMN description TEXT NULL" },
  { name: "unit", sql: "ALTER TABLE supplier_products ADD COLUMN unit VARCHAR(60) NULL" },
  { name: "stock_qty", sql: "ALTER TABLE supplier_products ADD COLUMN stock_qty INT NOT NULL DEFAULT 0" },
  { name: "price_wholesale", sql: "ALTER TABLE supplier_products ADD COLUMN price_wholesale DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "is_active", sql: "ALTER TABLE supplier_products ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE supplier_products ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE supplier_products ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "supplier_products");
  console.log("[createSupplierProductsTable] creating `supplier_products`...");
  await pool.query(CREATE_SQL);
  console.log("[createSupplierProductsTable] `supplier_products` OK");

  if (existed) {
    console.log("[createSupplierProductsTable] table préexistante, vérification des colonnes...");
    await ensureColumns(pool, "supplier_products", REQUIRED_COLUMNS, "[createSupplierProductsTable]");
  }

  await pool.end();
  console.log("[createSupplierProductsTable] done");
}

main().catch((e) => {
  console.error("[createSupplierProductsTable] FAILED:", e.message || e);
  process.exit(1);
});
