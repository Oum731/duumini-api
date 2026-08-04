// src/scripts/addVendorApplicationIdentityFields.js
// Usage: node src/scripts/addVendorApplicationIdentityFields.js
// Ajoute la pièce d'identité (passeport/carte de séjour/CNI) et la photo
// requises pour la candidature livreur (vérification d'identité avant
// validation à l'agence DUUMINI). Champs nullable : seule la candidature
// LIVREUR les utilise, comme dfe_url/rc_url ne servent qu'aux candidatures
// fournisseur/revendeur.
//
// Additif uniquement, aucune ligne existante affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE vendor_applications
    ADD COLUMN IF NOT EXISTS id_document_url VARCHAR(500) NULL AFTER rc_url,
    ADD COLUMN IF NOT EXISTS id_document_type ENUM('PASSPORT','CARTE_SEJOUR','CNI') NULL AFTER id_document_url,
    ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500) NULL AFTER id_document_type
`;

async function main() {
  const pool = getPool();

  console.log("[addVendorApplicationIdentityFields] altering `vendor_applications`...");
  await pool.query(ALTER_SQL);
  console.log(
    "[addVendorApplicationIdentityFields] `vendor_applications` OK (id_document_url, id_document_type, photo_url)"
  );

  await pool.end();
  console.log("[addVendorApplicationIdentityFields] done");
}

main().catch((e) => {
  console.error("[addVendorApplicationIdentityFields] FAILED:", e.message || e);
  process.exit(1);
});
