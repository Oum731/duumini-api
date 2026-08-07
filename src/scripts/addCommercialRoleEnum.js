// src/scripts/addCommercialRoleEnum.js
// Usage: node src/scripts/addCommercialRoleEnum.js
// `users.role` est un ENUM MySQL strict ('MEMBER','VENDEUR','FOURNISSEUR',
// 'LIVREUR','ADMIN') — sans ce script, toute tentative d'y écrire
// 'COMMERCIAL' échoue silencieusement en chaîne vide (comportement MySQL
// pour une valeur ENUM invalide hors mode strict). Ajoute uniquement
// 'COMMERCIAL', sans toucher aux valeurs existantes ni à la valeur par
// défaut.
//
// Note découverte en vérifiant ce script : l'ENUM ne contient pas non plus
// 'RESTAURANT' ni 'CLIENT', pourtant référencés dans le code applicatif
// (normalizeRole, isRestaurant) — bug latent préexistant, hors scope ici,
// signalé séparément plutôt que corrigé au passage.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE users
    MODIFY COLUMN role ENUM('MEMBER','VENDEUR','FOURNISSEUR','LIVREUR','COMMERCIAL','ADMIN')
    NOT NULL DEFAULT 'MEMBER'
`;

async function main() {
  const pool = getPool();

  console.log("[addCommercialRoleEnum] altering `users`.`role`...");
  await pool.query(ALTER_SQL);
  console.log("[addCommercialRoleEnum] `users`.`role` OK (+COMMERCIAL)");

  await pool.end();
  console.log("[addCommercialRoleEnum] done");
}

main().catch((e) => {
  console.error("[addCommercialRoleEnum] FAILED:", e.message || e);
  process.exit(1);
});
