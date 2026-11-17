// src/scripts/createLocationSuggestionsTable.js
// Usage: node src/scripts/createLocationSuggestionsTable.js
//
// Table `location_suggestions` (ville/commune/quartier déjà vus), utilisée
// par src/routes/locations.js pour l'autocomplétion de ville/commune/
// quartier au checkout. Absente de cette base (confirmé : 500 sur
// POST /api/locations/cities et consorts). commune/quartier sont
// nullables (une ville seule peut être enregistrée sans commune/quartier,
// voir POST /track kind=VILLE). Idempotent (CREATE TABLE IF NOT EXISTS) -
// safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS location_suggestions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    city VARCHAR(120) NOT NULL,
    commune VARCHAR(120) NULL,
    quartier VARCHAR(120) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_location_suggestions (city, commune, quartier),
    INDEX idx_location_suggestions_city (city),
    INDEX idx_location_suggestions_commune (city, commune)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "city", sql: "ALTER TABLE location_suggestions ADD COLUMN city VARCHAR(120) NOT NULL" },
  { name: "commune", sql: "ALTER TABLE location_suggestions ADD COLUMN commune VARCHAR(120) NULL" },
  { name: "quartier", sql: "ALTER TABLE location_suggestions ADD COLUMN quartier VARCHAR(120) NULL" },
  { name: "created_at", sql: "ALTER TABLE location_suggestions ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "location_suggestions");
  console.log("[createLocationSuggestionsTable] creating `location_suggestions`...");
  await pool.query(CREATE_SQL);
  console.log("[createLocationSuggestionsTable] `location_suggestions` OK");

  if (existed) {
    await ensureColumns(pool, "location_suggestions", REQUIRED_COLUMNS, "[createLocationSuggestionsTable]");
  }

  await pool.end();
  console.log("[createLocationSuggestionsTable] done");
}

main().catch((e) => {
  console.error("[createLocationSuggestionsTable] FAILED:", e.message || e);
  process.exit(1);
});
