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

const ALTER_SQL = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS brand VARCHAR(120) NULL AFTER name,
    ADD COLUMN IF NOT EXISTS conditionnement VARCHAR(120) NULL AFTER description
`;

async function main() {
  const pool = getPool();

  console.log("[addProductBrandFields] altering `products`...");
  await pool.query(ALTER_SQL);
  console.log("[addProductBrandFields] `products` OK (brand, conditionnement)");

  await pool.end();
  console.log("[addProductBrandFields] done");
}

main().catch((e) => {
  console.error("[addProductBrandFields] FAILED:", e.message || e);
  process.exit(1);
});
