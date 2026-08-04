// src/scripts/addCourierTripTrackingFields.js
// Usage: node src/scripts/addCourierTripTrackingFields.js
// Ajoute la zone de service couvrant le point de départ (reporting +
// matching, cf. src/utils/zones.js) et la position live du livreur pendant
// une course ACCEPTED/IN_PROGRESS (cf. PATCH /:id/position dans
// src/routes/courierTrips.js) — alimente la carte de suivi client.
//
// Additif uniquement, aucune ligne existante affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE courier_trips
    ADD COLUMN IF NOT EXISTS zone_code VARCHAR(20) NULL AFTER country_code,
    ADD COLUMN IF NOT EXISTS livreur_lat DECIMAL(10,7) NULL AFTER livreur_user_id,
    ADD COLUMN IF NOT EXISTS livreur_lng DECIMAL(10,7) NULL AFTER livreur_lat,
    ADD COLUMN IF NOT EXISTS livreur_location_at TIMESTAMP NULL AFTER livreur_lng
`;

async function main() {
  const pool = getPool();

  console.log("[addCourierTripTrackingFields] altering `courier_trips`...");
  await pool.query(ALTER_SQL);
  console.log(
    "[addCourierTripTrackingFields] `courier_trips` OK (zone_code, livreur_lat, livreur_lng, livreur_location_at)"
  );

  await pool.end();
  console.log("[addCourierTripTrackingFields] done");
}

main().catch((e) => {
  console.error("[addCourierTripTrackingFields] FAILED:", e.message || e);
  process.exit(1);
});
