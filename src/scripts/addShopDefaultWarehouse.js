// src/scripts/addShopDefaultWarehouse.js
// Usage: node src/scripts/addShopDefaultWarehouse.js
//
// Rattache une boutique à un entrepôt par défaut : les commandes sur les
// produits de cette boutique décrémenteront cet entrepôt (sauf si le
// produit a sa propre surcharge, voir products.warehouse_id dans
// addProductWarehouseAndUnits.js). NULL = pas d'entrepôt dédié, on
// retombe sur le premier entrepôt actif (comportement actuel, inchangé
// tant qu'un seul entrepôt existe).
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [table, column],
  );
  return rows.length > 0;
}

async function main() {
  const pool = getPool();

  const exists = await columnExists(pool, "shops", "default_warehouse_id");

  if (exists) {
    console.log("[addShopDefaultWarehouse] default_warehouse_id already exists, nothing to do");
  } else {
    console.log("[addShopDefaultWarehouse] adding shops.default_warehouse_id...");
    await pool.query(`ALTER TABLE shops ADD COLUMN default_warehouse_id INT NULL`);
    await pool.query(
      `ALTER TABLE shops ADD CONSTRAINT fk_shops_default_warehouse
         FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id)`,
    );
    console.log("[addShopDefaultWarehouse] done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addShopDefaultWarehouse] FAILED:", e.message || e);
  process.exit(1);
});
