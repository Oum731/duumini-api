// src/scripts/createProductVariantsTable.js
// Usage: node src/scripts/createProductVariantsTable.js
//
// Table `product_variants` (taille/couleur/SKU par produit), utilisée par
// src/routes/products.js. Absente de cet environnement (créée à la main
// sur l'ancienne base de production, jamais versionnée). Idempotent -
// safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_PRODUCT_VARIANTS = `
  CREATE TABLE IF NOT EXISTS product_variants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT NOT NULL,
    size VARCHAR(60) NULL,
    color VARCHAR(60) NULL,
    sku VARCHAR(120) NULL,
    stock INT NOT NULL DEFAULT 0,
    price_override DECIMAL(10,2) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    INDEX idx_product_variants_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createProductVariantsTable] creating `product_variants`...");
  await pool.query(CREATE_PRODUCT_VARIANTS);
  console.log("[createProductVariantsTable] `product_variants` OK");

  await pool.end();
  console.log("[createProductVariantsTable] done");
}

main().catch((e) => {
  console.error("[createProductVariantsTable] FAILED:", e.message || e);
  process.exit(1);
});
