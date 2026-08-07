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

const ALTER_SQL = `
  ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS commercial_id INT NULL,
    ADD COLUMN IF NOT EXISTS commercial_commission_rate DECIMAL(5,4) NULL,
    ADD COLUMN IF NOT EXISTS commercial_commission_amount DECIMAL(12,2) NULL,
    ADD COLUMN IF NOT EXISTS commercial_commission_status ENUM('PENDING','PAID') NULL
`;

async function main() {
  const pool = getPool();

  console.log("[addOrderCommercialFields] altering `orders`...");
  await pool.query(ALTER_SQL);
  console.log("[addOrderCommercialFields] `orders` OK (commercial_* fields)");

  await pool.end();
  console.log("[addOrderCommercialFields] done");
}

main().catch((e) => {
  console.error("[addOrderCommercialFields] FAILED:", e.message || e);
  process.exit(1);
});
