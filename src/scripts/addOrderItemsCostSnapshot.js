// src/scripts/addOrderItemsCostSnapshot.js
// Usage: node src/scripts/addOrderItemsCostSnapshot.js
//
// Phase 2 (marge au lieu du prix) : pour calculer une commission sur la
// marge et non sur le prix de vente, il faut connaître le coût au moment
// de la vente. On le fige dans order_items.unit_cost_snapshot à la
// création de la commande (voir buildCleanItemsWithPromo dans orders.js) :
// si le coût fournisseur change plus tard, les commandes déjà passées
// gardent leur marge/commission d'origine, jamais recalculée à tort.
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

  const exists = await columnExists(pool, "order_items", "unit_cost_snapshot");

  if (exists) {
    console.log("[addOrderItemsCostSnapshot] unit_cost_snapshot already exists, nothing to do");
  } else {
    console.log("[addOrderItemsCostSnapshot] adding order_items.unit_cost_snapshot...");
    await pool.query(
      `ALTER TABLE order_items ADD COLUMN unit_cost_snapshot DECIMAL(10,2) NULL AFTER unit_price`,
    );
    console.log("[addOrderItemsCostSnapshot] done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addOrderItemsCostSnapshot] FAILED:", e.message || e);
  process.exit(1);
});
