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
const { tableExists, ensureColumns } = require("./_schemaUtils");

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

// CREATE TABLE IF NOT EXISTS ne fait rien si `product_variants` existait
// déjà (créée à la main sur l'ancienne base, parfois sans `product_id`) -
// on vérifie et complète les colonnes après coup.
const REQUIRED_COLUMNS = [
  { name: "product_id", sql: "ALTER TABLE product_variants ADD COLUMN product_id BIGINT NOT NULL" },
  { name: "size", sql: "ALTER TABLE product_variants ADD COLUMN size VARCHAR(60) NULL" },
  { name: "color", sql: "ALTER TABLE product_variants ADD COLUMN color VARCHAR(60) NULL" },
  { name: "sku", sql: "ALTER TABLE product_variants ADD COLUMN sku VARCHAR(120) NULL" },
  { name: "stock", sql: "ALTER TABLE product_variants ADD COLUMN stock INT NOT NULL DEFAULT 0" },
  { name: "price_override", sql: "ALTER TABLE product_variants ADD COLUMN price_override DECIMAL(10,2) NULL" },
  { name: "is_active", sql: "ALTER TABLE product_variants ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE product_variants ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE product_variants ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "product_variants");
  console.log("[createProductVariantsTable] creating `product_variants`...");
  await pool.query(CREATE_PRODUCT_VARIANTS);
  console.log("[createProductVariantsTable] `product_variants` OK");

  if (existed) {
    console.log("[createProductVariantsTable] table préexistante, vérification des colonnes...");
    await ensureColumns(pool, "product_variants", REQUIRED_COLUMNS, "[createProductVariantsTable]");
  }

  await pool.end();
  console.log("[createProductVariantsTable] done");
}

main().catch((e) => {
  console.error("[createProductVariantsTable] FAILED:", e.message || e);
  process.exit(1);
});
