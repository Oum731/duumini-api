// src/scripts/addShopType.js
// Usage: node src/scripts/addShopType.js
//
// Ajoute shops.shop_type (VENDOR/SUPPLIER/RESTAURANT) si absent. La colonne
// est déjà lue ailleurs (products.js, users.js) de façon défensive — ce
// script garantit qu'elle existe réellement, pour que le filtrage par type
// dans GET /api/shops (page Fournisseurs / page Vendeurs) fonctionne.
//
// ⚠️ NULL par défaut, jamais 'VENDOR' : products.js traite déjà une valeur
// NULL comme VENDOR pour l'affichage du catalogue public (COALESCE(...,
// 'VENDOR')), donc le site public n'est pas affecté. Mais si on mettait un
// DEFAULT 'VENDOR' ici, TOUTES les boutiques existantes se retrouveraient
// explicitement taguées VENDOR d'un coup — ce qui casserait l'idée que
// Duumini soit seul vendeur tant que l'admin n'a pas explicitement affecté
// ce type à une boutique depuis la nouvelle page Vendeurs.
//
// Idempotent — safe à relancer.
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

  const exists = await columnExists(pool, "shops", "shop_type");

  if (exists) {
    console.log("[addShopType] shop_type already exists, nothing to do");
  } else {
    console.log("[addShopType] adding shops.shop_type...");
    await pool.query(
      `ALTER TABLE shops
         ADD COLUMN shop_type ENUM('VENDOR','SUPPLIER','RESTAURANT') NULL DEFAULT NULL`,
    );
    console.log("[addShopType] done");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[addShopType] FAILED:", e.message || e);
  process.exit(1);
});
