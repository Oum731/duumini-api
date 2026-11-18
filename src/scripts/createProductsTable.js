// src/scripts/createProductsTable.js
// Usage: node src/scripts/createProductsTable.js
//
// Table `products`, reconstruite de zéro (décision du 2026-11-18). Jamais
// créée par nos scripts jusqu'ici, elle préexistait depuis l'ancienne
// base Hostinger. La table la plus riche en colonnes du projet.
//
// Points d'attention :
// - `warehouse_id` est un INT simple SANS contrainte FK (même raison que
//   shops.default_warehouse_id : `warehouses` est créée plus tard).
// - `available_cities` : le code (detectCitiesColumn) teste dynamiquement
//   plusieurs noms possibles (available_cities/cities/villes) - on retient
//   le premier candidat de la liste testée en priorité.
// - `duumini_rate` : jamais posée par un script dédié (déjà présente sur
//   l'ancienne base), type déduit par cohérence avec commission_rate
//   ailleurs dans le projet.
// - Pas de colonne image/cover ici : toutes les images passent par
//   `product_images` (table séparée, déjà existante).
// - Pas de `updated_at` : jamais lu ni écrit nulle part dans le code.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS products (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    shop_id BIGINT NOT NULL,
    country_code CHAR(2) NOT NULL DEFAULT 'MA',
    category_id BIGINT NULL,
    sub_category_id INT NULL,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(120) NULL,
    slug VARCHAR(255) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    supplier_price_ht DECIMAL(12,2) NULL,
    partner_price_ht DECIMAL(12,2) NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
    description TEXT NULL,
    conditionnement VARCHAR(120) NULL,
    stock INT NOT NULL DEFAULT 0,
    is_featured TINYINT(1) NOT NULL DEFAULT 0,
    promo_eligible TINYINT(1) NOT NULL DEFAULT 0,
    promo_discount_type ENUM('AMOUNT','PERCENT') NULL,
    promo_discount_value DECIMAL(10,2) NULL,
    promo_free_delivery TINYINT(1) NOT NULL DEFAULT 0,
    duumini_rate DECIMAL(5,4) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    vertical ENUM('FOOD','MARKET','FASHION') NULL,
    warehouse_id INT NULL,
    units_per_carton INT NULL,
    available_cities JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_products_slug (slug),
    FOREIGN KEY (shop_id) REFERENCES shops(id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    INDEX idx_products_category (category_id),
    INDEX idx_products_sub_category (sub_category_id),
    INDEX idx_products_shop (shop_id),
    INDEX idx_products_vertical (vertical),
    INDEX idx_products_is_active (is_active),
    INDEX idx_products_warehouse (warehouse_id),
    INDEX idx_products_country (country_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "shop_id", sql: "ALTER TABLE products ADD COLUMN shop_id BIGINT NOT NULL" },
  { name: "country_code", sql: "ALTER TABLE products ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA'" },
  { name: "category_id", sql: "ALTER TABLE products ADD COLUMN category_id BIGINT NULL" },
  { name: "sub_category_id", sql: "ALTER TABLE products ADD COLUMN sub_category_id INT NULL" },
  { name: "name", sql: "ALTER TABLE products ADD COLUMN name VARCHAR(255) NOT NULL" },
  { name: "brand", sql: "ALTER TABLE products ADD COLUMN brand VARCHAR(120) NULL" },
  { name: "slug", sql: "ALTER TABLE products ADD COLUMN slug VARCHAR(255) NOT NULL" },
  { name: "price", sql: "ALTER TABLE products ADD COLUMN price DECIMAL(10,2) NOT NULL" },
  { name: "supplier_price_ht", sql: "ALTER TABLE products ADD COLUMN supplier_price_ht DECIMAL(12,2) NULL" },
  { name: "partner_price_ht", sql: "ALTER TABLE products ADD COLUMN partner_price_ht DECIMAL(12,2) NULL" },
  { name: "currency", sql: "ALTER TABLE products ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MAD'" },
  { name: "description", sql: "ALTER TABLE products ADD COLUMN description TEXT NULL" },
  { name: "conditionnement", sql: "ALTER TABLE products ADD COLUMN conditionnement VARCHAR(120) NULL" },
  { name: "stock", sql: "ALTER TABLE products ADD COLUMN stock INT NOT NULL DEFAULT 0" },
  { name: "is_featured", sql: "ALTER TABLE products ADD COLUMN is_featured TINYINT(1) NOT NULL DEFAULT 0" },
  { name: "promo_eligible", sql: "ALTER TABLE products ADD COLUMN promo_eligible TINYINT(1) NOT NULL DEFAULT 0" },
  { name: "promo_discount_type", sql: "ALTER TABLE products ADD COLUMN promo_discount_type ENUM('AMOUNT','PERCENT') NULL" },
  { name: "promo_discount_value", sql: "ALTER TABLE products ADD COLUMN promo_discount_value DECIMAL(10,2) NULL" },
  { name: "promo_free_delivery", sql: "ALTER TABLE products ADD COLUMN promo_free_delivery TINYINT(1) NOT NULL DEFAULT 0" },
  { name: "duumini_rate", sql: "ALTER TABLE products ADD COLUMN duumini_rate DECIMAL(5,4) NULL" },
  { name: "is_active", sql: "ALTER TABLE products ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "vertical", sql: "ALTER TABLE products ADD COLUMN vertical ENUM('FOOD','MARKET','FASHION') NULL" },
  { name: "warehouse_id", sql: "ALTER TABLE products ADD COLUMN warehouse_id INT NULL" },
  { name: "units_per_carton", sql: "ALTER TABLE products ADD COLUMN units_per_carton INT NULL" },
  { name: "available_cities", sql: "ALTER TABLE products ADD COLUMN available_cities JSON NULL" },
  { name: "created_at", sql: "ALTER TABLE products ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "products");
  console.log("[createProductsTable] creating `products`...");
  await pool.query(CREATE_SQL);
  console.log("[createProductsTable] `products` OK");

  if (existed) {
    await ensureColumns(pool, "products", REQUIRED_COLUMNS, "[createProductsTable]");
  }

  await pool.end();
  console.log("[createProductsTable] done");
}

main().catch((e) => {
  console.error("[createProductsTable] FAILED:", e.message || e);
  process.exit(1);
});
