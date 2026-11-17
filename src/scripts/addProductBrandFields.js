// src/scripts/addProductBrandFields.js
// Usage: node src/scripts/addProductBrandFields.js
// Ajoute `brand` (marque) et `conditionnement` (format/packaging) sur
// products, requis par le Catalogue unifié (filtre marque + fiche produit
// avec origine/conditionnement — voir Document de Référence Refonte V1).
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune colonne existante
// n'est modifiée ou supprimée. Idempotent, safe à relancer. Les deux
// colonnes sont nullable (pas de valeur par défaut à deviner pour les
// produits déjà en base).

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

// "ADD COLUMN IF NOT EXISTS" n'est pas supporté par ce serveur -> on
// vérifie nous-mêmes avant d'altérer.
const ALTERS = [
  { column: "brand", sql: `ALTER TABLE products ADD COLUMN brand VARCHAR(120) NULL AFTER name` },
  {
    column: "conditionnement",
    sql: `ALTER TABLE products ADD COLUMN conditionnement VARCHAR(120) NULL AFTER description`,
  },
];

async function main() {
  const pool = getPool();

  console.log("[addProductBrandFields] altering `products`...");
  for (const { column, sql } of ALTERS) {
    if (await columnExists(pool, "products", column)) {
      console.log(`[addProductBrandFields] ${column} already exists, skipping`);
      continue;
    }
    await pool.query(sql);
  }
  console.log("[addProductBrandFields] `products` OK (brand, conditionnement)");

  await pool.end();
  console.log("[addProductBrandFields] done");
}

main().catch((e) => {
  console.error("[addProductBrandFields] FAILED:", e.message || e);
  process.exit(1);
});
