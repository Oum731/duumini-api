// src/scripts/createLivreurProfilesTable.js
// Usage: node src/scripts/createLivreurProfilesTable.js
// Extension 1:1 de `users` pour role=LIVREUR (équivalent de `shops` pour
// les vendeurs) : pays/ville de rattachement + disponibilité, utilisés
// pour cibler les notifications de nouvelles courses.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS livreur_profiles (
    user_id INT PRIMARY KEY,
    country_code VARCHAR(4) NOT NULL,
    city VARCHAR(120) NULL,
    vehicle_type ENUM('MOTO','VOITURE','VELO','A_PIED') NULL,
    is_available TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createLivreurProfilesTable] creating `livreur_profiles`...");
  await pool.query(CREATE_TABLE);
  console.log("[createLivreurProfilesTable] `livreur_profiles` OK");

  await pool.end();
  console.log("[createLivreurProfilesTable] done");
}

main().catch((e) => {
  console.error("[createLivreurProfilesTable] FAILED:", e.message || e);
  process.exit(1);
});
