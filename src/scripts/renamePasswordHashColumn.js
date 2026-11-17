// src/scripts/renamePasswordHashColumn.js
// Usage: node src/scripts/renamePasswordHashColumn.js
//
// Le code actuel (src/routes/auth.js) lit/écrit `users.password`, mais
// cet environnement a encore l'ancienne colonne `password_hash` (avec les
// vrais hash bcrypt des comptes existants). On RENOMME la colonne au lieu
// d'en ajouter une vide, pour ne jamais perdre les mots de passe déjà en
// base - les comptes existants doivent continuer à pouvoir se connecter.
//
// Idempotent : si `password` existe déjà, ou si `password_hash` n'existe
// plus, ne fait rien. Safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
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

  const hasPassword = await columnExists(pool, "users", "password");
  if (hasPassword) {
    console.log("[renamePasswordHashColumn] `users.password` already exists, nothing to do");
    await pool.end();
    return;
  }

  const oldCol = await columnExists(pool, "users", "password_hash");
  if (!oldCol) {
    console.log(
      "[renamePasswordHashColumn] ni `password` ni `password_hash` trouvées - création de `password` vide",
    );
    await pool.query(`ALTER TABLE users ADD COLUMN password VARCHAR(255) NOT NULL`);
    await pool.end();
    console.log("[renamePasswordHashColumn] done (colonne vide créée)");
    return;
  }

  console.log("[renamePasswordHashColumn] renommage password_hash -> password...");
  await pool.query(
    `ALTER TABLE users CHANGE COLUMN password_hash password ${oldCol.COLUMN_TYPE} NOT NULL`,
  );
  console.log("[renamePasswordHashColumn] `users.password` OK (données conservées)");

  await pool.end();
  console.log("[renamePasswordHashColumn] done");
}

main().catch((e) => {
  console.error("[renamePasswordHashColumn] FAILED:", e.message || e);
  process.exit(1);
});
