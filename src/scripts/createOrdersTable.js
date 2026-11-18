// src/scripts/createOrdersTable.js
// Usage: node src/scripts/createOrdersTable.js
//
// Table `orders`, reconstruite de zéro (décision du 2026-11-18). Jamais
// créée par nos scripts jusqu'ici, elle préexistait depuis l'ancienne
// base Hostinger. Fichier source principal : src/routes/orders.js
// (plusieurs milliers de lignes).
//
// Points d'attention :
// - Pas de `shop_id` direct sur orders : une commande peut être
//   multi-vendeur, le rattachement boutique se fait uniquement via
//   order_items.product_id -> products.shop_id (voir
//   vendorOwnsWholeOrder dans orders.js). Volontaire, ne pas "corriger".
// - `affiliate_id` est un INT simple SANS FK : la table `affiliates` est
//   créée plus tard dans l'ordre des migrations.
// - `receipt_token` a un UNIQUE KEY : c'est le token public des liens
//   /r/:token et /verify/:token, une collision serait un vrai problème
//   de sécurité.
// - address/contact/payment sont stockés en JSON libre (objets variables
//   selon le contexte, pas de sous-colonnes figées).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    created_by_admin_id BIGINT NULL,
    created_via VARCHAR(20) NULL,
    status ENUM('OPEN','PREPARATION','DELIVERY','DONE','CANCELLED') NOT NULL DEFAULT 'OPEN',
    address JSON NOT NULL,
    contact JSON NULL,
    geo_link VARCHAR(512) NULL,
    items_subtotal DECIMAL(12,2) NULL,
    delivery_fee DECIMAL(10,2) NULL,
    admin_discount_type ENUM('NONE','AMOUNT','PERCENT') NULL DEFAULT 'NONE',
    admin_discount_value DECIMAL(10,2) NULL DEFAULT 0,
    admin_discount_amount DECIMAL(10,2) NULL DEFAULT 0,
    admin_discount_label VARCHAR(120) NULL,
    discounted_by_admin_id BIGINT NULL,
    total DECIMAL(12,2) NOT NULL,
    commission_duumini DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
    receipt_number VARCHAR(40) NULL,
    receipt_token VARCHAR(64) NULL,
    payment JSON NULL,
    payment_status ENUM('PAID','UNPAID','PARTIAL','PENDING') NULL,
    paid_amount DECIMAL(12,2) NULL DEFAULT 0,
    remaining_amount DECIMAL(12,2) NULL,
    affiliate_id INT NULL,
    affiliate_code VARCHAR(40) NULL,
    affiliate_commission_rate DECIMAL(5,2) NULL,
    affiliate_commission_amount DECIMAL(12,2) NULL,
    commercial_id INT NULL,
    commercial_commission_rate DECIMAL(5,4) NULL,
    commercial_commission_amount DECIMAL(12,2) NULL,
    commercial_commission_status ENUM('PENDING','PAID') NULL,
    country_code CHAR(2) NOT NULL DEFAULT 'MA',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_orders_receipt_token (receipt_token),
    UNIQUE KEY uniq_orders_receipt_number (receipt_number),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by_admin_id) REFERENCES users(id),
    FOREIGN KEY (discounted_by_admin_id) REFERENCES users(id),
    FOREIGN KEY (commercial_id) REFERENCES users(id),
    INDEX idx_orders_user (user_id),
    INDEX idx_orders_status (status),
    INDEX idx_orders_commercial (commercial_id),
    INDEX idx_orders_affiliate (affiliate_id),
    INDEX idx_orders_created (created_at),
    INDEX idx_orders_country (country_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "user_id", sql: "ALTER TABLE orders ADD COLUMN user_id BIGINT NULL" },
  { name: "created_by_admin_id", sql: "ALTER TABLE orders ADD COLUMN created_by_admin_id BIGINT NULL" },
  { name: "created_via", sql: "ALTER TABLE orders ADD COLUMN created_via VARCHAR(20) NULL" },
  { name: "status", sql: "ALTER TABLE orders ADD COLUMN status ENUM('OPEN','PREPARATION','DELIVERY','DONE','CANCELLED') NOT NULL DEFAULT 'OPEN'" },
  { name: "address", sql: "ALTER TABLE orders ADD COLUMN address JSON NOT NULL" },
  { name: "contact", sql: "ALTER TABLE orders ADD COLUMN contact JSON NULL" },
  { name: "geo_link", sql: "ALTER TABLE orders ADD COLUMN geo_link VARCHAR(512) NULL" },
  { name: "items_subtotal", sql: "ALTER TABLE orders ADD COLUMN items_subtotal DECIMAL(12,2) NULL" },
  { name: "delivery_fee", sql: "ALTER TABLE orders ADD COLUMN delivery_fee DECIMAL(10,2) NULL" },
  { name: "admin_discount_type", sql: "ALTER TABLE orders ADD COLUMN admin_discount_type ENUM('NONE','AMOUNT','PERCENT') NULL DEFAULT 'NONE'" },
  { name: "admin_discount_value", sql: "ALTER TABLE orders ADD COLUMN admin_discount_value DECIMAL(10,2) NULL DEFAULT 0" },
  { name: "admin_discount_amount", sql: "ALTER TABLE orders ADD COLUMN admin_discount_amount DECIMAL(10,2) NULL DEFAULT 0" },
  { name: "admin_discount_label", sql: "ALTER TABLE orders ADD COLUMN admin_discount_label VARCHAR(120) NULL" },
  { name: "discounted_by_admin_id", sql: "ALTER TABLE orders ADD COLUMN discounted_by_admin_id BIGINT NULL" },
  { name: "total", sql: "ALTER TABLE orders ADD COLUMN total DECIMAL(12,2) NOT NULL" },
  { name: "commission_duumini", sql: "ALTER TABLE orders ADD COLUMN commission_duumini DECIMAL(12,2) NOT NULL DEFAULT 0" },
  { name: "currency", sql: "ALTER TABLE orders ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MAD'" },
  { name: "receipt_number", sql: "ALTER TABLE orders ADD COLUMN receipt_number VARCHAR(40) NULL" },
  { name: "receipt_token", sql: "ALTER TABLE orders ADD COLUMN receipt_token VARCHAR(64) NULL" },
  { name: "payment", sql: "ALTER TABLE orders ADD COLUMN payment JSON NULL" },
  { name: "payment_status", sql: "ALTER TABLE orders ADD COLUMN payment_status ENUM('PAID','UNPAID','PARTIAL','PENDING') NULL" },
  { name: "paid_amount", sql: "ALTER TABLE orders ADD COLUMN paid_amount DECIMAL(12,2) NULL DEFAULT 0" },
  { name: "remaining_amount", sql: "ALTER TABLE orders ADD COLUMN remaining_amount DECIMAL(12,2) NULL" },
  { name: "affiliate_id", sql: "ALTER TABLE orders ADD COLUMN affiliate_id INT NULL" },
  { name: "affiliate_code", sql: "ALTER TABLE orders ADD COLUMN affiliate_code VARCHAR(40) NULL" },
  { name: "affiliate_commission_rate", sql: "ALTER TABLE orders ADD COLUMN affiliate_commission_rate DECIMAL(5,2) NULL" },
  { name: "affiliate_commission_amount", sql: "ALTER TABLE orders ADD COLUMN affiliate_commission_amount DECIMAL(12,2) NULL" },
  { name: "commercial_id", sql: "ALTER TABLE orders ADD COLUMN commercial_id INT NULL" },
  { name: "commercial_commission_rate", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_rate DECIMAL(5,4) NULL" },
  { name: "commercial_commission_amount", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_amount DECIMAL(12,2) NULL" },
  { name: "commercial_commission_status", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_status ENUM('PENDING','PAID') NULL" },
  { name: "country_code", sql: "ALTER TABLE orders ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA'" },
  { name: "created_at", sql: "ALTER TABLE orders ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE orders ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "orders");
  console.log("[createOrdersTable] creating `orders`...");
  await pool.query(CREATE_SQL);
  console.log("[createOrdersTable] `orders` OK");

  if (existed) {
    await ensureColumns(pool, "orders", REQUIRED_COLUMNS, "[createOrdersTable]");
  }

  await pool.end();
  console.log("[createOrdersTable] done");
}

main().catch((e) => {
  console.error("[createOrdersTable] FAILED:", e.message || e);
  process.exit(1);
});
