// src/scripts/createVendorApplicationsTable.js
// Usage: node src/scripts/createVendorApplicationsTable.js
// Crée la table `vendor_applications` (Phase 3 de la refonte Duumini 2.0) :
// candidatures publiques de vendeurs/fournisseurs/restaurants avec pièces
// justificatives (DFE, Registre de Commerce). Idempotent (IF NOT EXISTS).
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS vendor_applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  applicant_type ENUM('VENDEUR','FOURNISSEUR','RESTAURANT') NOT NULL,
  legal_name VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(30) NOT NULL,
  contact_email VARCHAR(255) NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'MA',
  city VARCHAR(120) NULL,
  message TEXT NULL,
  dfe_url VARCHAR(500) NULL,
  rc_url VARCHAR(500) NULL,
  status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  admin_notes TEXT NULL,
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function main() {
  const pool = getPool();

  console.log("[createVendorApplicationsTable] creating `vendor_applications`...");
  await pool.query(CREATE_TABLE);
  console.log("[createVendorApplicationsTable] `vendor_applications` OK");

  await pool.end();
  console.log("[createVendorApplicationsTable] done");
}

main().catch((e) => {
  console.error("[createVendorApplicationsTable] FAILED:", e.message || e);
  process.exit(1);
});
