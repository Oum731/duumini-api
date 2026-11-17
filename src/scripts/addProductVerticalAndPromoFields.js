// src/scripts/addProductVerticalAndPromoFields.js
// Usage: node src/scripts/addProductVerticalAndPromoFields.js
// Ajoute vertical, sub_category_id, promo_discount_type, promo_discount_value
// et promo_free_delivery sur products. Idempotent - safe à relancer.

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

const ALTERS = [
  { column: "vertical", sql: `ALTER TABLE products ADD COLUMN vertical ENUM('FOOD','MARKET','FASHION') NULL AFTER category_id` },
  { column: "sub_category_id", sql: `ALTER TABLE products ADD COLUMN sub_category_id INT NULL AFTER category_id` },
  { column: "promo_discount_type", sql: `ALTER TABLE products ADD COLUMN promo_discount_type ENUM('AMOUNT','PERCENT') NULL` },
  { column: "promo_discount_value", sql: `ALTER TABLE products ADD COLUMN promo_discount_value DECIMAL(10,2) NULL` },
  { column: "promo_free_delivery", sql: `ALTER TABLE products ADD COLUMN promo_free_delivery TINYINT(1) NULL DEFAULT 0` },
];

async function main() {
  const pool = getPool();

  for (const { column, sql } of ALTERS) {
    if (await columnExists(pool, "products", column)) {
      console.log(`[addProductVerticalAndPromoFields] ${column} already exists, skipping`);
      continue;
    }
    console.log(`[addProductVerticalAndPromoFields] adding ${column}...`);
    await pool.query(sql);
  }

  await pool.end();
  console.log("[addProductVerticalAndPromoFields] done");
}

main().catch((e) => {
  console.error("[addProductVerticalAndPromoFields] FAILED:", e.message || e);
  process.exit(1);
});
