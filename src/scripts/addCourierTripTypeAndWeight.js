// src/scripts/addCourierTripTypeAndWeight.js
// Usage: node src/scripts/addCourierTripTypeAndWeight.js
// Ajoute le type de course (récupération simple vs achat + envoi) et le
// poids "colis lourd" (>30kg) requis par la nouvelle tarification par
// tranches (voir src/routes/courierTrips.js, computePrice()).
//
// Additif uniquement : ADD COLUMN IF NOT EXISTS, aucune ligne existante
// n'est affectée (valeurs par défaut PICKUP / non-lourd).

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE courier_trips
    ADD COLUMN IF NOT EXISTS trip_type ENUM('PICKUP','SHOPPING') NOT NULL DEFAULT 'PICKUP' AFTER package_description,
    ADD COLUMN IF NOT EXISTS is_heavy_package TINYINT(1) NOT NULL DEFAULT 0 AFTER trip_type
`;

async function main() {
  const pool = getPool();

  console.log("[addCourierTripTypeAndWeight] altering `courier_trips`...");
  await pool.query(ALTER_SQL);
  console.log("[addCourierTripTypeAndWeight] `courier_trips` OK (trip_type, is_heavy_package)");

  await pool.end();
  console.log("[addCourierTripTypeAndWeight] done");
}

main().catch((e) => {
  console.error("[addCourierTripTypeAndWeight] FAILED:", e.message || e);
  process.exit(1);
});
