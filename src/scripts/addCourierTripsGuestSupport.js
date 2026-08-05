// src/scripts/addCourierTripsGuestSupport.js
// Usage: node src/scripts/addCourierTripsGuestSupport.js
// Permet la réservation d'une course sans compte (invité) — même convention
// que `orders.user_id`, déjà nullable pour les commandes invité. La FK
// existante (requester_user_id -> users.id) reste en place ; NULL est
// simplement une valeur valide pour une colonne FK nullable en MySQL.
//
// Additif uniquement, aucune ligne existante affectée (les courses déjà
// créées ont toutes un requester_user_id renseigné).

require("dotenv").config();
const { getPool } = require("../lib/db");

async function main() {
  const pool = getPool();

  console.log("[addCourierTripsGuestSupport] altering `courier_trips`...");
  await pool.query(
    `ALTER TABLE courier_trips MODIFY COLUMN requester_user_id INT NULL`
  );
  console.log("[addCourierTripsGuestSupport] `courier_trips.requester_user_id` is now nullable");

  await pool.end();
  console.log("[addCourierTripsGuestSupport] done");
}

main().catch((e) => {
  console.error("[addCourierTripsGuestSupport] FAILED:", e.message || e);
  process.exit(1);
});
