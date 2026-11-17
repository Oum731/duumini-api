// src/scripts/createSubCategoriesTable.js
// Usage: node src/scripts/createSubCategoriesTable.js
//
// Table `sub_categories`, utilisée par src/routes/subCategories.js et
// référencée par products.sub_category_id. Absente de cet environnement
// (créée à la main sur l'ancienne base de production, jamais versionnée).
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SUB_CATEGORIES = `
  CREATE TABLE IF NOT EXISTS sub_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id BIGINT NOT NULL,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    vertical ENUM('FOOD','MARKET','FASHION') NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sub_categories_category_slug (category_id, slug),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    INDEX idx_sub_categories_vertical (vertical)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "category_id", sql: "ALTER TABLE sub_categories ADD COLUMN category_id BIGINT NOT NULL" },
  { name: "name", sql: "ALTER TABLE sub_categories ADD COLUMN name VARCHAR(160) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE sub_categories ADD COLUMN slug VARCHAR(160) NOT NULL" },
  { name: "vertical", sql: "ALTER TABLE sub_categories ADD COLUMN vertical ENUM('FOOD','MARKET','FASHION') NULL" },
  { name: "is_active", sql: "ALTER TABLE sub_categories ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE sub_categories ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE sub_categories ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "sub_categories");
  console.log("[createSubCategoriesTable] creating `sub_categories`...");
  await pool.query(CREATE_SUB_CATEGORIES);
  console.log("[createSubCategoriesTable] `sub_categories` OK");

  if (existed) {
    console.log("[createSubCategoriesTable] table préexistante, vérification des colonnes...");
    await ensureColumns(pool, "sub_categories", REQUIRED_COLUMNS, "[createSubCategoriesTable]");
  }

  await pool.end();
  console.log("[createSubCategoriesTable] done");
}

main().catch((e) => {
  console.error("[createSubCategoriesTable] FAILED:", e.message || e);
  process.exit(1);
});
