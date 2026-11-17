// src/scripts/createProductImagesTable.js
// Usage: node src/scripts/createProductImagesTable.js
//
// Table `product_images`, utilisée par src/routes/products.js pour stocker
// les photos d'un produit (une ligne par image, triée par sort_order).
// Absente de cet environnement (créée à la main sur l'ancienne base de
// production, jamais versionnée). Idempotent - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_PRODUCT_IMAGES = `
  CREATE TABLE IF NOT EXISTS product_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT NOT NULL,
    url VARCHAR(1024) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    INDEX idx_product_images_product (product_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createProductImagesTable] creating `product_images`...");
  await pool.query(CREATE_PRODUCT_IMAGES);
  console.log("[createProductImagesTable] `product_images` OK");

  await pool.end();
  console.log("[createProductImagesTable] done");
}

main().catch((e) => {
  console.error("[createProductImagesTable] FAILED:", e.message || e);
  process.exit(1);
});
