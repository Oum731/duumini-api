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
  { column: "logo", sql: `ALTER TABLE shops ADD COLUMN logo VARCHAR(512) NULL` },
  { column: "cover", sql: `ALTER TABLE shops ADD COLUMN cover VARCHAR(512) NULL` },
];

async function main() {
  const pool = getPool();

  console.log("[addShopLogoCoverFields] altering `shops`...");
  for (const { column, sql } of ALTERS) {
    if (await columnExists(pool, "shops", column)) {
      console.log(`[addShopLogoCoverFields] ${column} already exists, skipping`);
      continue;
    }
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
