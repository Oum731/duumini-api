// src/scripts/addOrderCommercialFields.js
// Usage: node src/scripts/addOrderCommercialFields.js
// Ajoute l'attribution "commercial" sur les commandes — même esprit que
// affiliate_id/affiliate_code déjà en place, mais posé uniquement depuis
// req.user.id (jamais depuis le payload client) quand la commande est
// créée via POST /api/orders/admin par un compte COMMERCIAL.
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune colonne existante
// n'est modifiée ou supprimée. Idempotent, safe à relancer. Tout nullable.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { ensureColumns } = require("./_schemaUtils");

// "ADD COLUMN IF NOT EXISTS" n'est pas supporté par ce serveur -> on
// vérifie nous-mêmes avant d'altérer (même pattern que les autres scripts
// add*.js de ce dossier).
const REQUIRED_COLUMNS = [
  { name: "commercial_id", sql: "ALTER TABLE orders ADD COLUMN commercial_id BIGINT NULL" },
  { name: "commercial_commission_rate", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_rate DECIMAL(5,4) NULL" },
  { name: "commercial_commission_amount", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_amount DECIMAL(12,2) NULL" },
  { name: "commercial_commission_status", sql: "ALTER TABLE orders ADD COLUMN commercial_commission_status ENUM('PENDING','PAID') NULL" },
];

async function main() {
  const pool = getPool();

  console.log("[addOrderCommercialFields] vérification des colonnes `orders`...");
  await ensureColumns(pool, "orders", REQUIRED_COLUMNS, "[addOrderCommercialFields]");
  console.log("[addOrderCommercialFields] `orders` OK (commercial_* fields)");

  await pool.end();
  console.log("[addOrderCommercialFields] done");
}

main().catch((e) => {
  console.error("[addOrderCommercialFields] FAILED:", e.message || e);
  process.exit(1);
});
