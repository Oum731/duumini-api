// src/scripts/addProductSupplierPriceField.js
// Usage: node src/scripts/addProductSupplierPriceField.js
// Ajoute `supplier_price_ht` (prix fournisseur hors taxes) sur products,
// pour permettre le calcul de la marge bénéficiaire (prix de vente - prix
// fournisseur) directement dans la gestion des produits.
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune colonne existante
// n'est modifiée ou supprimée. Idempotent, safe à relancer. Nullable (pas
// de valeur par défaut à deviner pour les produits déjà en base).

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS supplier_price_ht DECIMAL(12,2) NULL AFTER price
`;

async function main() {
  const pool = getPool();

  console.log("[addProductSupplierPriceField] altering `products`...");
  await pool.query(ALTER_SQL);
  console.log("[addProductSupplierPriceField] `products` OK (supplier_price_ht)");

  await pool.end();
  console.log("[addProductSupplierPriceField] done");
}

main().catch((e) => {
  console.error("[addProductSupplierPriceField] FAILED:", e.message || e);
  process.exit(1);
});
