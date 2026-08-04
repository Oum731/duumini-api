// src/scripts/createServiceZonesTable.js
// Usage: node src/scripts/createServiceZonesTable.js
// Crée la table `service_zones` — équivalent de `country_config` mais pour
// les villes/zones de couverture du service de courses livreur. Ajouter une
// nouvelle ville ensuite ne nécessite qu'une insertion dans cette table,
// aucune modification de code (voir src/utils/zones.js).
//
// Idempotent : CREATE TABLE IF NOT EXISTS + INSERT ... ON DUPLICATE KEY
// UPDATE. Safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS service_zones (
  code VARCHAR(20) PRIMARY KEY,
  country_code CHAR(2) NOT NULL,
  city_label VARCHAR(100) NOT NULL,
  center_lat DECIMAL(10,7) NOT NULL,
  center_lng DECIMAL(10,7) NOT NULL,
  radius_km DECIMAL(6,2) NOT NULL DEFAULT 25,
  dispatch_radius_km DECIMAL(5,2) NOT NULL DEFAULT 6,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const SEED_ROWS = [
  {
    code: "MA-CASA",
    country_code: "MA",
    city_label: "Casablanca",
    center_lat: 33.5731,
    center_lng: -7.5898,
    radius_km: 30,
    dispatch_radius_km: 6,
    is_active: 1,
    sort_order: 1,
  },
];

const UPSERT_ROW = `
INSERT INTO service_zones
  (code, country_code, city_label, center_lat, center_lng, radius_km, dispatch_radius_km, is_active, sort_order)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  country_code = VALUES(country_code),
  city_label = VALUES(city_label),
  center_lat = VALUES(center_lat),
  center_lng = VALUES(center_lng),
  radius_km = VALUES(radius_km),
  dispatch_radius_km = VALUES(dispatch_radius_km),
  is_active = VALUES(is_active),
  sort_order = VALUES(sort_order)
`;

async function main() {
  const pool = getPool();

  console.log("[createServiceZonesTable] creating `service_zones`...");
  await pool.query(CREATE_TABLE);
  console.log("[createServiceZonesTable] `service_zones` OK");

  console.log("[createServiceZonesTable] seeding rows...");
  for (const row of SEED_ROWS) {
    await pool.query(UPSERT_ROW, [
      row.code,
      row.country_code,
      row.city_label,
      row.center_lat,
      row.center_lng,
      row.radius_km,
      row.dispatch_radius_km,
      row.is_active,
      row.sort_order,
    ]);
  }
  console.log(`[createServiceZonesTable] seeded ${SEED_ROWS.length} rows`);

  await pool.end();
  console.log("[createServiceZonesTable] done");
}

main().catch((e) => {
  console.error("[createServiceZonesTable] FAILED:", e.message || e);
  process.exit(1);
});
