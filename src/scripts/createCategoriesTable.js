// src/scripts/createCategoriesTable.js
// Usage: node src/scripts/createCategoriesTable.js
//
// Table `categories` (catégories de PRODUITS - différente de
// `shop_categories`, catégories de boutiques), reconstruite de zéro
// (décision du 2026-11-18). Jamais créée par nos scripts jusqu'ici, elle
// préexistait depuis l'ancienne base Hostinger.
//
// Point d'attention : `vertical` et `is_active` ne sont PAS incluses -
// elles sont feature-détectées dynamiquement par categories.js
// (detectColumn) et le code fonctionne très bien sans. Un ancien script
// archivé (migrateToDocCategories.js) suppose `vertical` mais ça a dû
// tourner sur un autre environnement : vérifié empiriquement que cette
// colonne n'existe pas réellement sur la base de production.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS categories (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    image_url VARCHAR(500) NULL,
    image_urls TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_categories_slug (slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "name", sql: "ALTER TABLE categories ADD COLUMN name VARCHAR(160) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE categories ADD COLUMN slug VARCHAR(160) NOT NULL" },
  { name: "image_url", sql: "ALTER TABLE categories ADD COLUMN image_url VARCHAR(500) NULL" },
  { name: "image_urls", sql: "ALTER TABLE categories ADD COLUMN image_urls TEXT NULL" },
  { name: "created_at", sql: "ALTER TABLE categories ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "categories");
  console.log("[createCategoriesTable] creating `categories`...");
  await pool.query(CREATE_SQL);
  console.log("[createCategoriesTable] `categories` OK");

  if (existed) {
    await ensureColumns(pool, "categories", REQUIRED_COLUMNS, "[createCategoriesTable]");
  }

  await pool.end();
  console.log("[createCategoriesTable] done");
}

main().catch((e) => {
  console.error("[createCategoriesTable] FAILED:", e.message || e);
  process.exit(1);
});
