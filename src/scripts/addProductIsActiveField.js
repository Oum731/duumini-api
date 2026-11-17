// src/scripts/addProductIsActiveField.js
// Usage: node src/scripts/addProductIsActiveField.js
// Ajoute `products.is_active` (filtre actif/inactif, utilisé partout dans
// products.js). Idempotent - safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

async function main() {
  const pool = getPool();

  if (await columnExists(pool, "products", "is_active")) {
    console.log("[addProductIsActiveField] already exists, nothing to do");
  } else {
    console.log("[addProductIsActiveField] altering `products`...");
    await pool.query(`ALTER TABLE products ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1`);
    console.log("[addProductIsActiveField] `products` OK (is_active)");
  }

  await pool.end();
  console.log("[addProductIsActiveField] done");
}

main().catch((e) => {
  console.error("[addProductIsActiveField] FAILED:", e.message || e);
  process.exit(1);
});
