// src/scripts/addProductPartnerPriceField.js
// Usage: node src/scripts/addProductPartnerPriceField.js
// Ajoute `partner_price_ht` (prix partenaire hors taxes) sur products —
// prix dédié affiché dans le Catalogue B2B (fournisseurs/partenaires,
// protégé par code), distinct du prix client public. Voir aussi
// supplier_price_ht (coût d'achat interne, jamais montré à qui que ce
// soit hors admin/vendeur) — les deux ne doivent jamais fuiter vers les
// routes publiques (voir products.js: omitInternalPriceFields).
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune colonne existante
// n'est modifiée ou supprimée. Idempotent, safe à relancer. Nullable.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS partner_price_ht DECIMAL(12,2) NULL AFTER supplier_price_ht
`;

async function main() {
  const pool = getPool();

  console.log("[addProductPartnerPriceField] altering `products`...");
  await pool.query(ALTER_SQL);
  console.log("[addProductPartnerPriceField] `products` OK (partner_price_ht)");

  await pool.end();
  console.log("[addProductPartnerPriceField] done");
}

main().catch((e) => {
  console.error("[addProductPartnerPriceField] FAILED:", e.message || e);
  process.exit(1);
});
