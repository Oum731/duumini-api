// src/scripts/createCommercialProfilesTable.js
// Usage: node src/scripts/createCommercialProfilesTable.js
// Table de profil pour le rôle COMMERCIAL — taux de commission individuel,
// utilisé pour calculer commercial_commission_amount à chaque commande
// déclarée (voir addOrderCommercialFields.js). Idempotent (CREATE TABLE IF
// NOT EXISTS), safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS commercial_profiles (
    user_id INT PRIMARY KEY,
    commission_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0500,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`;

async function main() {
  const pool = getPool();

  console.log("[createCommercialProfilesTable] creating `commercial_profiles`...");
  await pool.query(CREATE_SQL);
  console.log("[createCommercialProfilesTable] `commercial_profiles` OK");

  await pool.end();
  console.log("[createCommercialProfilesTable] done");
}

main().catch((e) => {
  console.error("[createCommercialProfilesTable] FAILED:", e.message || e);
  process.exit(1);
});
