// src/scripts/addLivreurPositionFields.js
// Usage: node src/scripts/addLivreurPositionFields.js
// Ajoute la dernière position connue d'un livreur (mise à jour côté client
// pendant qu'il est disponible, cf. PATCH /api/livreur-profiles/me/position)
// et sa dernière zone connue — sert au matching de proximité pour de
// nouvelles courses (cf. src/utils/zones.js, queueLivreurNotifications dans
// src/routes/courierTrips.js).
//
// Additif uniquement, aucune ligne existante affectée. Les livreurs sans
// position connue (last_lat/last_lng NULL) sont simplement exclus du
// matching de proximité tant qu'ils n'ont pas envoyé de position.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE livreur_profiles
    ADD COLUMN IF NOT EXISTS last_lat DECIMAL(10,7) NULL AFTER is_blocked,
    ADD COLUMN IF NOT EXISTS last_lng DECIMAL(10,7) NULL AFTER last_lat,
    ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMP NULL AFTER last_lng,
    ADD COLUMN IF NOT EXISTS zone_code VARCHAR(20) NULL AFTER last_location_at
`;

async function main() {
  const pool = getPool();

  console.log("[addLivreurPositionFields] altering `livreur_profiles`...");
  await pool.query(ALTER_SQL);
  console.log(
    "[addLivreurPositionFields] `livreur_profiles` OK (last_lat, last_lng, last_location_at, zone_code)"
  );

  await pool.end();
  console.log("[addLivreurPositionFields] done");
}

main().catch((e) => {
  console.error("[addLivreurPositionFields] FAILED:", e.message || e);
  process.exit(1);
});
