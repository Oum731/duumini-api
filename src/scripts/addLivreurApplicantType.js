// src/scripts/addLivreurApplicantType.js
// Usage: node src/scripts/addLivreurApplicantType.js
// Ajoute la valeur ENUM 'LIVREUR' à vendor_applications.applicant_type,
// requis pour que le nouveau service de courses indépendantes puisse
// recruter des livreurs via le même pipeline de candidature vétée que
// fournisseur/revendeur/partenaire.
//
// MODIFY COLUMN sur un ENUM existant : additif, aucune ligne existante
// n'est affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE vendor_applications
    MODIFY COLUMN applicant_type ENUM('VENDEUR','FOURNISSEUR','RESTAURANT','PARTENAIRE','LIVREUR') NOT NULL
`;

async function main() {
  const pool = getPool();

  console.log("[addLivreurApplicantType] altering `vendor_applications`...");
  await pool.query(ALTER_SQL);
  console.log("[addLivreurApplicantType] `vendor_applications` OK (applicant_type + LIVREUR)");

  await pool.end();
  console.log("[addLivreurApplicantType] done");
}

main().catch((e) => {
  console.error("[addLivreurApplicantType] FAILED:", e.message || e);
  process.exit(1);
});
