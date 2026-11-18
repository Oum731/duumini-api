// src/scripts/createUsersTable.js
// Usage: node src/scripts/createUsersTable.js
//
// Table `users`, reconstruite de zéro (décision du 2026-11-18 : table
// jamais créée par nos scripts jusqu'ici, elle préexistait depuis
// l'ancienne base Hostinger - on reconstruit son schéma complet en se
// basant sur l'usage réel dans tout le code applicatif).
//
// Points d'attention (voir recherche détaillée) :
// - `avatar` est LONGTEXT (photo encodée en base64 stockée directement en
//   base, pas une URL malgré le nom hérité de l'ancien `avatar_url`).
// - `role` est un VARCHAR libre (pas un ENUM MySQL strict) : le code a deux
//   listes de rôles divergentes selon le fichier (addCommercialRoleEnum.js
//   vs normalizeRole() dans users.js), un ENUM strict figerait
//   arbitrairement l'une des deux et viderait silencieusement toute valeur
//   hors liste (comportement MySQL documenté et déjà source de bugs ici).
// - `phone` a un UNIQUE KEY en filet de sécurité contre les doublons exacts
//   simultanés, mais la dé-duplication principale se fait en code
//   applicatif par comparaison normalisée (sans +/espaces/tirets/points) -
//   un numéro saisi sous deux formats différents n'est PAS bloqué par
//   cette contrainte, c'est voulu (voir normPhone()/REPLACE(...) partout).
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
    first_name VARCHAR(120) NULL,
    last_name VARCHAR(120) NULL,
    avatar LONGTEXT NULL,
    ville VARCHAR(120) NULL,
    commune VARCHAR(120) NULL,
    quartier VARCHAR(120) NULL,
    sexe ENUM('M','F') NULL,
    is_active TINYINT(1) NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_users_phone (phone),
    INDEX idx_users_role (role)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "phone", sql: "ALTER TABLE users ADD COLUMN phone VARCHAR(32) NOT NULL" },
  { name: "password", sql: "ALTER TABLE users ADD COLUMN password VARCHAR(255) NOT NULL" },
  { name: "role", sql: "ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'MEMBER'" },
  { name: "first_name", sql: "ALTER TABLE users ADD COLUMN first_name VARCHAR(120) NULL" },
  { name: "last_name", sql: "ALTER TABLE users ADD COLUMN last_name VARCHAR(120) NULL" },
  { name: "avatar", sql: "ALTER TABLE users ADD COLUMN avatar LONGTEXT NULL" },
  { name: "ville", sql: "ALTER TABLE users ADD COLUMN ville VARCHAR(120) NULL" },
  { name: "commune", sql: "ALTER TABLE users ADD COLUMN commune VARCHAR(120) NULL" },
  { name: "quartier", sql: "ALTER TABLE users ADD COLUMN quartier VARCHAR(120) NULL" },
  { name: "sexe", sql: "ALTER TABLE users ADD COLUMN sexe ENUM('M','F') NULL" },
  { name: "is_active", sql: "ALTER TABLE users ADD COLUMN is_active TINYINT(1) NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "users");
  console.log("[createUsersTable] creating `users`...");
  await pool.query(CREATE_SQL);
  console.log("[createUsersTable] `users` OK");

  if (existed) {
    await ensureColumns(pool, "users", REQUIRED_COLUMNS, "[createUsersTable]");
  }

  await pool.end();
  console.log("[createUsersTable] done");
}

main().catch((e) => {
  console.error("[createUsersTable] FAILED:", e.message || e);
  process.exit(1);
});
