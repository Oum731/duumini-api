// src/scripts/migrateUserProfileFields.js
// Usage: node src/scripts/migrateUserProfileFields.js
//
// Le code actuel (auth.js, users.js) lit/écrit users.avatar/ville/commune/
// quartier/sexe, absents de cet environnement qui a encore l'ancien schéma
// (avatar_url, city, address_line, gender avec 'male'/'female'/'other').
//
// - avatar  : renommage depuis avatar_url (même usage, données conservées)
// - sexe    : nouvelle colonne ENUM('M','F'), backfill best-effort depuis
//             gender (male->M, female->F, other->NULL) ; gender n'est pas
//             supprimée, juste plus utilisée par le code actuel
// - ville, commune, quartier : nouvelles colonnes (pas d'équivalent sûr à
//   renommer - city/address_line ne portent pas le même découpage), vides
//   au départ, à resaisir par les utilisateurs
//
// Idempotent - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function getColumn(pool, table, column) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME, COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [table, column],
  );
  return rows[0] || null;
}

async function main() {
  const pool = getPool();

  // --- avatar (renommage depuis avatar_url) ---
  if (await getColumn(pool, "users", "avatar")) {
    console.log("[migrateUserProfileFields] users.avatar already exists, skipping");
  } else {
    const oldAvatar = await getColumn(pool, "users", "avatar_url");
    if (oldAvatar) {
      console.log("[migrateUserProfileFields] renaming avatar_url -> avatar...");
      await pool.query(
        `ALTER TABLE users CHANGE COLUMN avatar_url avatar ${oldAvatar.COLUMN_TYPE} NULL`,
      );
    } else {
      console.log("[migrateUserProfileFields] creating users.avatar (vide)...");
      await pool.query(`ALTER TABLE users ADD COLUMN avatar VARCHAR(512) NULL`);
    }
    console.log("[migrateUserProfileFields] users.avatar OK");
  }

  // --- ville / commune / quartier (nouvelles colonnes) ---
  for (const col of ["ville", "commune", "quartier"]) {
    if (await getColumn(pool, "users", col)) {
      console.log(`[migrateUserProfileFields] users.${col} already exists, skipping`);
      continue;
    }
    console.log(`[migrateUserProfileFields] creating users.${col}...`);
    await pool.query(`ALTER TABLE users ADD COLUMN ${col} VARCHAR(120) NULL`);
  }

  // --- sexe (nouvelle colonne, backfill depuis gender si possible) ---
  if (await getColumn(pool, "users", "sexe")) {
    console.log("[migrateUserProfileFields] users.sexe already exists, skipping");
  } else {
    console.log("[migrateUserProfileFields] creating users.sexe...");
    await pool.query(`ALTER TABLE users ADD COLUMN sexe ENUM('M','F') NULL`);

    const oldGender = await getColumn(pool, "users", "gender");
    if (oldGender) {
      console.log("[migrateUserProfileFields] backfill sexe depuis gender...");
      const [r1] = await pool.query(`UPDATE users SET sexe='M' WHERE gender='male'`);
      const [r2] = await pool.query(`UPDATE users SET sexe='F' WHERE gender='female'`);
      console.log(
        `[migrateUserProfileFields] backfill OK (${r1.affectedRows} M, ${r2.affectedRows} F)`,
      );
    }
  }

  await pool.end();
  console.log("[migrateUserProfileFields] done");
}

main().catch((e) => {
  console.error("[migrateUserProfileFields] FAILED:", e.message || e);
  process.exit(1);
});
