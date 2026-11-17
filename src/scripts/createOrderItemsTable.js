// src/scripts/createOrderItemsTable.js
// Usage: node src/scripts/createOrderItemsTable.js
//
// Table `order_items`, totalement absente de cette base (confirmé via
// "Table 'duuminic_besoin.order_items' doesn't exist" sur
// /api/products/top-ordered - mais c'est une table centrale : toutes les
// commandes, rapports de ventes, stock, etc. en dépendent). Colonnes de
// base déduites de orders.js (INSERT INTO order_items) et de l'usage
// `oi.*` dans tout le reste du code (orders.js, shops.js, reports.js,
// products.js, productRatings.js).
//
// Les colonnes optionnelles liées aux promos (base_unit_price,
// promo_applied, promo_type, promo_value) et au coût figé
// (unit_cost_snapshot, voir addOrderItemsCostSnapshot.js) sont déjà
// feature-detectées par orders.js (getOrderItemsPromoColsCached) - elles
// ne sont PAS créées ici, pas nécessaires pour que les commandes
// fonctionnent de base.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL,
    product_id BIGINT NOT NULL,
    variant_id INT NULL,
    qty INT NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    INDEX idx_order_items_order (order_id),
    INDEX idx_order_items_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "order_id", sql: "ALTER TABLE order_items ADD COLUMN order_id BIGINT NOT NULL" },
  { name: "product_id", sql: "ALTER TABLE order_items ADD COLUMN product_id BIGINT NOT NULL" },
  { name: "variant_id", sql: "ALTER TABLE order_items ADD COLUMN variant_id INT NULL" },
  { name: "qty", sql: "ALTER TABLE order_items ADD COLUMN qty INT NOT NULL DEFAULT 1" },
  { name: "unit_price", sql: "ALTER TABLE order_items ADD COLUMN unit_price DECIMAL(10,2) NOT NULL" },
  { name: "created_at", sql: "ALTER TABLE order_items ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "order_items");
  console.log("[createOrderItemsTable] creating `order_items`...");
  await pool.query(CREATE_SQL);
  console.log("[createOrderItemsTable] `order_items` OK");

  if (existed) {
    console.log("[createOrderItemsTable] table préexistante, vérification des colonnes...");
    await ensureColumns(pool, "order_items", REQUIRED_COLUMNS, "[createOrderItemsTable]");
  }

  await pool.end();
  console.log("[createOrderItemsTable] done");
}

main().catch((e) => {
  console.error("[createOrderItemsTable] FAILED:", e.message || e);
  process.exit(1);
});
