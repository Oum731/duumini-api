// src/scripts/addPartenaireApplicantType.js
// Usage: node src/scripts/addPartenaireApplicantType.js
// Ajoute la valeur ENUM 'PARTENAIRE' à vendor_applications.applicant_type,
// requis pour que le sélecteur "Rejoindre DUUMINI" à 4 profils (Fournisseur/
// Revendeur/Client/Partenaire — Document de Référence Refonte V1, section 8)
// puisse tracer les demandes de partenariat comme les autres candidatures.
//
// MODIFY COLUMN sur un ENUM existant : additif (nouvelle valeur possible en
// plus des 3 existantes), aucune ligne existante n'est affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE vendor_applications
    MODIFY COLUMN applicant_type ENUM('VENDEUR','FOURNISSEUR','RESTAURANT','PARTENAIRE') NOT NULL
`;

async function main() {
  const pool = getPool();

  console.log("[addPartenaireApplicantType] altering `vendor_applications`...");
  await pool.query(ALTER_SQL);
  console.log("[addPartenaireApplicantType] `vendor_applications` OK (applicant_type + PARTENAIRE)");

  await pool.end();
  console.log("[addPartenaireApplicantType] done");
}

main().catch((e) => {
  console.error("[addPartenaireApplicantType] FAILED:", e.message || e);
  process.exit(1);
});
