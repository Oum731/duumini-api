// src/scripts/createShopsTable.js
// Usage: node src/scripts/createShopsTable.js
//
// Table `shops`, reconstruite de zéro (décision du 2026-11-18). Jamais
// créée par nos scripts jusqu'ici, elle préexistait depuis l'ancienne
// base Hostinger.
//
// Points d'attention :
// - `default_warehouse_id` est un INT simple SANS contrainte FK : la table
//   `warehouses` est créée plus tard dans l'ordre des migrations (après
//   shops/products, car warehouse_stock a besoin que products/shops
//   existent déjà). La colonne existe quand même dès le départ, la FK
//   n'est pas nécessaire au fonctionnement de l'app.
// - `country` ET `country_code` coexistent (le code utilise les deux,
//   jamais nettoyé) - garder les deux pour ne rien casser.
// - `shop_type` est un ENUM strict à 3 valeurs seulement (VENDOR/
//   SUPPLIER/RESTAURANT) : le code compare parfois aussi contre
//   'VENDEUR'/'SHOP'/'FOURNISSEUR' (synonymes FR) mais ce sont des
//   comparaisons défensives qui ne matcheront jamais une vraie valeur
//   stockée - ne pas élargir l'ENUM pour ça.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS shops (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    description TEXT NULL,
    category_id INT NULL,
    address VARCHAR(255) NULL,
    city VARCHAR(120) NULL,
    country VARCHAR(100) NULL DEFAULT 'Maroc',
    country_code CHAR(2) NOT NULL DEFAULT 'MA',
    lat DECIMAL(10,7) NULL,
    lng DECIMAL(10,7) NULL,
    logo VARCHAR(512) NULL,
    cover VARCHAR(512) NULL,
    shop_type ENUM('VENDOR','SUPPLIER','RESTAURANT') NULL,
    default_warehouse_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_shops_slug (slug),
    FOREIGN KEY (owner_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES shop_categories(id),
    INDEX idx_shops_owner (owner_id),
    INDEX idx_shops_category (category_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "owner_id", sql: "ALTER TABLE shops ADD COLUMN owner_id BIGINT NOT NULL" },
  { name: "name", sql: "ALTER TABLE shops ADD COLUMN name VARCHAR(255) NOT NULL" },
  { name: "slug", sql: "ALTER TABLE shops ADD COLUMN slug VARCHAR(255) NOT NULL" },
  { name: "description", sql: "ALTER TABLE shops ADD COLUMN description TEXT NULL" },
  { name: "category_id", sql: "ALTER TABLE shops ADD COLUMN category_id INT NULL" },
  { name: "address", sql: "ALTER TABLE shops ADD COLUMN address VARCHAR(255) NULL" },
  { name: "city", sql: "ALTER TABLE shops ADD COLUMN city VARCHAR(120) NULL" },
  { name: "country", sql: "ALTER TABLE shops ADD COLUMN country VARCHAR(100) NULL DEFAULT 'Maroc'" },
  { name: "country_code", sql: "ALTER TABLE shops ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA'" },
  { name: "lat", sql: "ALTER TABLE shops ADD COLUMN lat DECIMAL(10,7) NULL" },
  { name: "lng", sql: "ALTER TABLE shops ADD COLUMN lng DECIMAL(10,7) NULL" },
  { name: "logo", sql: "ALTER TABLE shops ADD COLUMN logo VARCHAR(512) NULL" },
  { name: "cover", sql: "ALTER TABLE shops ADD COLUMN cover VARCHAR(512) NULL" },
  { name: "shop_type", sql: "ALTER TABLE shops ADD COLUMN shop_type ENUM('VENDOR','SUPPLIER','RESTAURANT') NULL" },
  { name: "default_warehouse_id", sql: "ALTER TABLE shops ADD COLUMN default_warehouse_id INT NULL" },
  { name: "created_at", sql: "ALTER TABLE shops ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "shops");
  console.log("[createShopsTable] creating `shops`...");
  await pool.query(CREATE_SQL);
  console.log("[createShopsTable] `shops` OK");

  if (existed) {
    await ensureColumns(pool, "shops", REQUIRED_COLUMNS, "[createShopsTable]");
  }

  await pool.end();
  console.log("[createShopsTable] done");
}

main().catch((e) => {
  console.error("[createShopsTable] FAILED:", e.message || e);
  process.exit(1);
});
