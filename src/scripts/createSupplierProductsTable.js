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

async function main() {
  const pool = getPool();

  console.log("[createSupplierProductsTable] creating `supplier_products`...");
  await pool.query(CREATE_SQL);
  console.log("[createSupplierProductsTable] `supplier_products` OK");

  await pool.end();
  console.log("[createSupplierProductsTable] done");
}

main().catch((e) => {
  console.error("[createSupplierProductsTable] FAILED:", e.message || e);
  process.exit(1);
});
