// src/scripts/createDeliveryZonesTable.js
// Usage: node src/scripts/createDeliveryZonesTable.js
//
// Table `delivery_zones`, utilisée par src/routes/delivery_zones.js.
// Absente de cet environnement (créée à la main sur l'ancienne base de
// production, jamais versionnée). Idempotent - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS delivery_zones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    city VARCHAR(120) NOT NULL,
    zone_name VARCHAR(120) NOT NULL,
    base_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    pickup_type ENUM('ADDRESS','VENDOR_POINT') NOT NULL DEFAULT 'ADDRESS',
    pickup_vendor_shop_id BIGINT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pickup_vendor_shop_id) REFERENCES shops(id),
    INDEX idx_delivery_zones_city (city)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "city", sql: "ALTER TABLE delivery_zones ADD COLUMN city VARCHAR(120) NOT NULL" },
  { name: "zone_name", sql: "ALTER TABLE delivery_zones ADD COLUMN zone_name VARCHAR(120) NOT NULL" },
  { name: "base_fee", sql: "ALTER TABLE delivery_zones ADD COLUMN base_fee DECIMAL(10,2) NOT NULL DEFAULT 0" },
  { name: "pickup_type", sql: "ALTER TABLE delivery_zones ADD COLUMN pickup_type ENUM('ADDRESS','VENDOR_POINT') NOT NULL DEFAULT 'ADDRESS'" },
  { name: "pickup_vendor_shop_id", sql: "ALTER TABLE delivery_zones ADD COLUMN pickup_vendor_shop_id BIGINT NULL" },
  { name: "is_active", sql: "ALTER TABLE delivery_zones ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE delivery_zones ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "delivery_zones");
  console.log("[createDeliveryZonesTable] creating `delivery_zones`...");
  await pool.query(CREATE_SQL);
  console.log("[createDeliveryZonesTable] `delivery_zones` OK");

  if (existed) {
    console.log("[createDeliveryZonesTable] table préexistante, vérification des colonnes...");
    await ensureColumns(pool, "delivery_zones", REQUIRED_COLUMNS, "[createDeliveryZonesTable]");
  }

  await pool.end();
  console.log("[createDeliveryZonesTable] done");
}

main().catch((e) => {
  console.error("[createDeliveryZonesTable] FAILED:", e.message || e);
  process.exit(1);
});
