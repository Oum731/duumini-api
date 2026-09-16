// src/scripts/addProductWarehouseAndUnits.js
// Usage: node src/scripts/addProductWarehouseAndUnits.js
//
// Deux ajouts liés à la gestion de stock par entrepôt :
//
// - products.warehouse_id : entrepôt précis pour ce produit, prioritaire
//   sur l'entrepôt par défaut de sa boutique (shops.default_warehouse_id,
//   voir addShopDefaultWarehouse.js). NULL = pas de surcharge, on utilise
//   l'entrepôt de la boutique puis, à défaut, le premier entrepôt actif.
//
// - products.units_per_carton : nombre de pièces dans un carton pour ce
//   produit. Le stock reste compté en pièces en interne (colonne `stock`
//   inchangée) ; ce champ sert uniquement à convertir une saisie en
//   cartons (livraison fournisseur, ajustement manuel) vers des pièces,
//   et à afficher le stock en cartons sur la fiche produit. NULL = ce
//   produit ne se suit pas par carton (vente à la pièce uniquement).
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

  const hasWarehouseId = await columnExists(pool, "products", "warehouse_id");
  if (hasWarehouseId) {
    console.log("[addProductWarehouseAndUnits] warehouse_id already exists, nothing to do");
  } else {
    console.log("[addProductWarehouseAndUnits] adding products.warehouse_id...");
    await pool.query(`ALTER TABLE products ADD COLUMN warehouse_id INT NULL AFTER shop_id`);
    await pool.query(
      `ALTER TABLE products ADD CONSTRAINT fk_products_warehouse
         FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)`,
    );
    console.log("[addProductWarehouseAndUnits] warehouse_id done");
  }

  const hasUnitsPerCarton = await columnExists(pool, "products", "units_per_carton");
  if (hasUnitsPerCarton) {
    console.log("[addProductWarehouseAndUnits] units_per_carton already exists, nothing to do");
  } else {
    console.log("[addProductWarehouseAndUnits] adding products.units_per_carton...");
    await pool.query(
      `ALTER TABLE products ADD COLUMN units_per_carton INT NULL AFTER stock`,
    );
    console.log("[addProductWarehouseAndUnits] units_per_carton done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addProductWarehouseAndUnits] FAILED:", e.message || e);
  process.exit(1);
});
