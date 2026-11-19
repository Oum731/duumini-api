// src/scripts/addShopCompanyId.js
// Usage: node src/scripts/addShopCompanyId.js
//
// Isolation par entreprise (demande explicite du user, 2026-11-19) : une
// entreprise (table `companies`, jusqu'ici réservée à l'abonnement/
// facturation) peut désormais regrouper plusieurs boutiques (`shops`).
// Tous les membres actifs de cette entreprise (`company_members`) voient
// alors les mêmes commandes/produits/dépenses, au lieu d'être limités à
// leur seule boutique (owner_id).
//
// Nullable : une boutique sans entreprise continue de fonctionner exactement
// comme avant (isolation par owner_id seul, comportement historique
// inchangé) - voir resolveVendorShopIds() dans src/middlewares/auth/index.js.
//
// Idempotent - safe à relancer. N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { ensureColumns } = require("./_schemaUtils");

const REQUIRED_COLUMNS = [
  { name: "company_id", sql: "ALTER TABLE shops ADD COLUMN company_id INT NULL" },
];

async function main() {
  const pool = getPool();

  console.log("[addShopCompanyId] vérification des colonnes `shops`...");
  await ensureColumns(pool, "shops", REQUIRED_COLUMNS, "[addShopCompanyId]");

  const [[{ hasIndex }]] = await pool.query(`
    SELECT COUNT(*) AS hasIndex FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_shops_company'
  `);
  if (!hasIndex) {
    console.log("[addShopCompanyId] ajout de l'index idx_shops_company...");
    await pool.query("ALTER TABLE shops ADD INDEX idx_shops_company (company_id)");
  } else {
    console.log("[addShopCompanyId] idx_shops_company already exists, skipping");
  }

  await pool.end();
  console.log("[addShopCompanyId] done");
}

main().catch((e) => {
  console.error("[addShopCompanyId] FAILED:", e.message || e);
  process.exit(1);
});
