// src/scripts/addVendorApplicationLocationFields.js
// Usage: node src/scripts/addVendorApplicationLocationFields.js
// Ajoute une position GPS optionnelle à la candidature — utile surtout pour
// les candidatures LIVREUR : copiée dans livreur_profiles.last_lat/last_lng
// à l'approbation (voir vendorApplications.js), le livreur a alors une
// position exploitable dès son compte créé, sans attendre sa première
// connexion à son tableau de bord.
//
// Additif uniquement, aucune ligne existante affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE vendor_applications
    ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7) NULL AFTER city,
    ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7) NULL AFTER lat
`;

async function main() {
  const pool = getPool();

  console.log("[addVendorApplicationLocationFields] altering `vendor_applications`...");
  await pool.query(ALTER_SQL);
  console.log("[addVendorApplicationLocationFields] `vendor_applications` OK (lat, lng)");

  await pool.end();
  console.log("[addVendorApplicationLocationFields] done");
}

main().catch((e) => {
  console.error("[addVendorApplicationLocationFields] FAILED:", e.message || e);
  process.exit(1);
});
