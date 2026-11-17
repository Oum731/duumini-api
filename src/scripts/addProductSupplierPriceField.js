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

const ALTER_SQL = `
  ALTER TABLE products
    ADD COLUMN supplier_price_ht DECIMAL(12,2) NULL AFTER price
`;

async function main() {
  const pool = getPool();

  if (await columnExists(pool, "products", "supplier_price_ht")) {
    console.log("[addProductSupplierPriceField] already exists, nothing to do");
    await pool.end();
    return;
  }

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
