// src/scripts/createCourierTripsTable.js
// Usage: node src/scripts/createCourierTripsTable.js
// Table du service de courses indépendantes (réservation d'un livreur pour
// transporter un colis d'un point A à un point B, sans lien avec les
// commandes produits). Une ligne = une course, commission DUUMINI incluse
// directement (pas de table de commissions séparée, cardinalité 1:1).
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS courier_trips (
    id INT AUTO_INCREMENT PRIMARY KEY,
    requester_user_id INT NOT NULL,
    livreur_user_id INT NULL,
    country_code VARCHAR(4) NOT NULL,
    pickup_address VARCHAR(255) NOT NULL,
    pickup_lat DECIMAL(10,7) NOT NULL,
    pickup_lng DECIMAL(10,7) NOT NULL,
    dropoff_address VARCHAR(255) NOT NULL,
    dropoff_lat DECIMAL(10,7) NOT NULL,
    dropoff_lng DECIMAL(10,7) NOT NULL,
    distance_km DECIMAL(6,2) NOT NULL,
    package_description TEXT NULL,
    price DECIMAL(10,2) NOT NULL,
    commission_rate DECIMAL(4,2) NOT NULL,
    commission_amount DECIMAL(10,2) NOT NULL,
    commission_status ENUM('PENDING','PAID') NOT NULL DEFAULT 'PENDING',
    commission_paid_at TIMESTAMP NULL,
    payment_method ENUM('CASH','BMCE','GAZHALA') NOT NULL DEFAULT 'CASH',
    status ENUM('REQUESTED','ACCEPTED','IN_PROGRESS','DELIVERED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    requester_phone VARCHAR(32) NOT NULL,
    requester_name VARCHAR(120) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP NULL,
    delivered_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,
    FOREIGN KEY (requester_user_id) REFERENCES users(id),
    FOREIGN KEY (livreur_user_id) REFERENCES users(id),
    INDEX idx_status (status),
    INDEX idx_livreur (livreur_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createCourierTripsTable] creating `courier_trips`...");
  await pool.query(CREATE_TABLE);
  console.log("[createCourierTripsTable] `courier_trips` OK");

  await pool.end();
  console.log("[createCourierTripsTable] done");
}

main().catch((e) => {
  console.error("[createCourierTripsTable] FAILED:", e.message || e);
  process.exit(1);
});
