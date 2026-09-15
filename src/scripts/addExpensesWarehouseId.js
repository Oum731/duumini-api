// src/scripts/addExpensesWarehouseId.js
// Usage: node src/scripts/addExpensesWarehouseId.js
//
// Refonte dépenses (Phase 3) : une dépense peut maintenant être rattachée
// à un entrepôt (loyer, personnel logistique, fournitures...) en plus du
// rattachement boutique existant. shop_id et warehouse_id restent tous les
// deux nullable : NULL des deux = dépense globale plateforme (déjà le
// comportement existant pour l'admin), shop_id seul = dépense boutique
// (inchangé), warehouse_id seul = dépense entrepôt (nouveau).
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

  const exists = await columnExists(pool, "expenses", "warehouse_id");

  if (exists) {
    console.log("[addExpensesWarehouseId] warehouse_id already exists, nothing to do");
  } else {
    console.log("[addExpensesWarehouseId] adding expenses.warehouse_id...");
    await pool.query(
      `ALTER TABLE expenses ADD COLUMN warehouse_id INT NULL AFTER shop_id`,
    );
    await pool.query(
      `ALTER TABLE expenses ADD CONSTRAINT fk_expenses_warehouse
         FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)`,
    );
    console.log("[addExpensesWarehouseId] done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addExpensesWarehouseId] FAILED:", e.message || e);
  process.exit(1);
});
