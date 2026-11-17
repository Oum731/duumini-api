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

async function main() {
  const pool = getPool();

  console.log("[createDeliveryZonesTable] creating `delivery_zones`...");
  await pool.query(CREATE_SQL);
  console.log("[createDeliveryZonesTable] `delivery_zones` OK");

  await pool.end();
  console.log("[createDeliveryZonesTable] done");
}

main().catch((e) => {
  console.error("[createDeliveryZonesTable] FAILED:", e.message || e);
  process.exit(1);
});
