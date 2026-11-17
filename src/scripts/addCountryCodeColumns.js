// src/scripts/addCountryCodeColumns.js
// Usage: node src/scripts/addCountryCodeColumns.js
// Ajoute `country_code` (ISO 3166-1 alpha-2) sur shops/products/orders,
// posé dès la Phase 0 de la refonte Duumini 2.0 pour que l'ouverture d'un
// nouveau pays ne soit jamais une urgence (voir docs/duumini-2.0/06-roadmap-risques.md
// et 09-expansion-panafricaine.md dans duumini-web).
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS (supporté par MariaDB),
// aucune colonne existante n'est modifiée ou supprimée. Idempotent, safe
// à relancer. Le DEFAULT 'MA' rétro-remplit automatiquement les lignes
// existantes (aujourd'hui 100% Maroc) au moment de l'ALTER.

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
// vérifie nous-mêmes avant d'altérer (même approche que
// addProductWarehouseAndUnits.js).
const ALTERS = [
  {
    table: "shops",
    sql: `ALTER TABLE shops
            ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA'`,
  },
  {
    table: "products",
    sql: `ALTER TABLE products
            ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA' AFTER shop_id`,
  },
  {
    table: "orders",
    sql: `ALTER TABLE orders
            ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'MA' AFTER user_id`,
  },
];

// Backfill best-effort pour les boutiques dont le texte libre `country`
// indique déjà la Côte d'Ivoire (aucune ligne connue aujourd'hui, mais
// évite un faux 'MA' si le script est relancé plus tard après un import).
const BACKFILL_SHOPS_CI = `
  UPDATE shops
     SET country_code = 'CI'
   WHERE country_code = 'MA'
     AND (country LIKE '%ivoire%' OR country LIKE '%Ivoire%' OR country = 'CI')
`;

async function main() {
  const pool = getPool();

  for (const { table, sql } of ALTERS) {
    if (await columnExists(pool, table, "country_code")) {
      console.log(`[addCountryCodeColumns] \`${table}\`.country_code already exists, skipping`);
      continue;
    }
    console.log(`[addCountryCodeColumns] altering \`${table}\`...`);
    await pool.query(sql);
    console.log(`[addCountryCodeColumns] \`${table}\` OK`);
  }

  if (await columnExists(pool, "shops", "country")) {
    console.log("[addCountryCodeColumns] backfill shops.country_code (CI heuristic)...");
    const [result] = await pool.query(BACKFILL_SHOPS_CI);
    console.log(`[addCountryCodeColumns] backfill OK (${result.affectedRows} row(s) updated)`);
  } else {
    console.log("[addCountryCodeColumns] \`shops\`.country n'existe pas ici, backfill ignoré");
  }

  await pool.end();
  console.log("[addCountryCodeColumns] done");
}

main().catch((e) => {
  console.error("[addCountryCodeColumns] FAILED:", e.message || e);
  process.exit(1);
});
