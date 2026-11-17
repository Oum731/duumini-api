// src/scripts/addShopLogoCoverFields.js
// Usage: node src/scripts/addShopLogoCoverFields.js
//
// Ajoute `logo` et `cover` sur shops (URLs Cloudinary), utilisées par
// src/routes/shops.js et src/routes/products.js. Remplacent l'ancienne
// approche logo_url/banner_url (images stockées en base64 directement en
// base) - celles-ci restent en place mais ne sont plus utilisées par le
// code actuel.
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune colonne existante
// n'est modifiée ou supprimée. Idempotent, safe à relancer. Nullable.

require("dotenv").config();
const { getPool } = require("../lib/db");

// Une colonne par ALTER : certaines versions de MariaDB n'acceptent pas
// plusieurs clauses "ADD COLUMN IF NOT EXISTS" dans la même instruction.
const ALTERS = [
  `ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo VARCHAR(512) NULL`,
  `ALTER TABLE shops ADD COLUMN IF NOT EXISTS cover VARCHAR(512) NULL`,
];

async function main() {
  const pool = getPool();

  console.log("[addShopLogoCoverFields] altering `shops`...");
  for (const sql of ALTERS) {
    await pool.query(sql);
  }
  console.log("[addShopLogoCoverFields] `shops` OK (logo, cover)");

  await pool.end();
  console.log("[addShopLogoCoverFields] done");
}

main().catch((e) => {
  console.error("[addShopLogoCoverFields] FAILED:", e.message || e);
  process.exit(1);
});
