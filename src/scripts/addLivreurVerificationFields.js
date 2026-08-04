// src/scripts/addLivreurVerificationFields.js
// Usage: node src/scripts/addLivreurVerificationFields.js
// Ajoute la pièce d'identité/photo (transmises depuis la candidature
// approuvée), le statut de vérification (candidature en ligne validée !=
// passage physique à l'agence validé), et le blocage pour commission
// impayée (cf. src/jobs/livreurSettlementCron.js).
//
// Additif uniquement, aucune ligne existante affectée. Les livreurs déjà
// créés avant cette migration démarrent à PENDING_VISIT (comportement
// sûr par défaut : ne peuvent pas accepter de courses tant qu'un admin ne
// les valide pas explicitement).

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE livreur_profiles
    ADD COLUMN IF NOT EXISTS id_document_url VARCHAR(500) NULL AFTER vehicle_type,
    ADD COLUMN IF NOT EXISTS id_document_type ENUM('PASSPORT','CARTE_SEJOUR','CNI') NULL AFTER id_document_url,
    ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500) NULL AFTER id_document_type,
    ADD COLUMN IF NOT EXISTS verification_status ENUM('PENDING_VISIT','VALIDATED') NOT NULL DEFAULT 'PENDING_VISIT' AFTER photo_url,
    ADD COLUMN IF NOT EXISTS is_blocked TINYINT(1) NOT NULL DEFAULT 0 AFTER verification_status
`;

async function main() {
  const pool = getPool();

  console.log("[addLivreurVerificationFields] altering `livreur_profiles`...");
  await pool.query(ALTER_SQL);
  console.log(
    "[addLivreurVerificationFields] `livreur_profiles` OK (identity fields, verification_status, is_blocked)"
  );

  await pool.end();
  console.log("[addLivreurVerificationFields] done");
}

main().catch((e) => {
  console.error("[addLivreurVerificationFields] FAILED:", e.message || e);
  process.exit(1);
});
