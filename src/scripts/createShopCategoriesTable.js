// src/scripts/createShopCategoriesTable.js
// Usage: node src/scripts/createShopCategoriesTable.js
//
// Table `shop_categories` (catégories de BOUTIQUES - différente de
// `categories`, qui sert aux produits), utilisée par
// src/routes/shopCategories.js et jointe dans src/routes/shops.js
// (LEFT JOIN shop_categories sc ON sc.id = s.category_id). Totalement
// absente de cette base (confirmé : 500 générique sur GET /api/shops).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS shop_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_shop_categories_slug (slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "name", sql: "ALTER TABLE shop_categories ADD COLUMN name VARCHAR(160) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE shop_categories ADD COLUMN slug VARCHAR(160) NOT NULL" },
  { name: "created_at", sql: "ALTER TABLE shop_categories ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "shop_categories");
  console.log("[createShopCategoriesTable] creating `shop_categories`...");
  await pool.query(CREATE_SQL);
  console.log("[createShopCategoriesTable] `shop_categories` OK");

  if (existed) {
    await ensureColumns(pool, "shop_categories", REQUIRED_COLUMNS, "[createShopCategoriesTable]");
  }

  await pool.end();
  console.log("[createShopCategoriesTable] done");
}

main().catch((e) => {
  console.error("[createShopCategoriesTable] FAILED:", e.message || e);
  process.exit(1);
});
