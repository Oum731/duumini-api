// src/scripts/createCompaniesTables.js
// Usage: node src/scripts/createCompaniesTables.js
// Crée les tables `companies` et `company_members` (module Entreprises, Phase 0
// de la refonte Duumini 2.0). Idempotent (IF NOT EXISTS) — safe à relancer.
// N'exécute jamais rien d'automatique : c'est un script à lancer à la main.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_COMPANIES = `
CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_id INT NOT NULL,
  legal_name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  supplier_type ENUM('FABRICANT','IMPORTATEUR','GROSSISTE','DISTRIBUTEUR','AUTRE') NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'MA',
  kyb_status ENUM('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const CREATE_COMPANY_MEMBERS = `
CREATE TABLE IF NOT EXISTS company_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  internal_role ENUM('OWNER','MANAGER','SALES','WAREHOUSE','ACCOUNTANT','VIEWER') NOT NULL,
  status ENUM('ACTIVE','INVITED','REMOVED') NOT NULL DEFAULT 'ACTIVE',
  invited_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_company_user (company_id, user_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function main() {
  const pool = getPool();

  console.log("[createCompaniesTables] creating `companies`...");
  await pool.query(CREATE_COMPANIES);
  console.log("[createCompaniesTables] `companies` OK");

  console.log("[createCompaniesTables] creating `company_members`...");
  await pool.query(CREATE_COMPANY_MEMBERS);
  console.log("[createCompaniesTables] `company_members` OK");

  await pool.end();
  console.log("[createCompaniesTables] done");
}

main().catch((e) => {
  console.error("[createCompaniesTables] FAILED:", e.message || e);
  process.exit(1);
});
