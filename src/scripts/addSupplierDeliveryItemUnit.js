// src/scripts/addSupplierDeliveryItemUnit.js
// Usage: node src/scripts/addSupplierDeliveryItemUnit.js
//
// Permet de saisir une ligne de livraison fournisseur en cartons plutôt
// qu'en pièces. `qty`/`unit_cost` restent tels que saisis par le
// gestionnaire (fidèles au bon de livraison papier, ex: "40 cartons à 120
// MAD"), et `base_qty` stocke la quantité convertie en pièces (grâce à
// products.units_per_carton) — c'est cette valeur en pièces qui alimente
// le ledger de stock (stock_movements/warehouse_stock), qui reste en
// pièces partout ailleurs dans le système.
//
// Backfill : les lignes déjà en base sont forcément en pièces (le champ
// n'existait pas), donc unit='PIECE' et base_qty=qty pour l'existant.
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

  const hasUnit = await columnExists(pool, "supplier_delivery_items", "unit");
  if (hasUnit) {
    console.log("[addSupplierDeliveryItemUnit] unit already exists, nothing to do");
  } else {
    console.log("[addSupplierDeliveryItemUnit] adding supplier_delivery_items.unit + base_qty...");
    await pool.query(
      `ALTER TABLE supplier_delivery_items
         ADD COLUMN unit ENUM('PIECE','CARTON') NOT NULL DEFAULT 'PIECE' AFTER qty,
         ADD COLUMN base_qty INT NULL AFTER unit`,
    );
    await pool.query(`UPDATE supplier_delivery_items SET base_qty = qty WHERE base_qty IS NULL`);
    console.log("[addSupplierDeliveryItemUnit] done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addSupplierDeliveryItemUnit] FAILED:", e.message || e);
  process.exit(1);
});
