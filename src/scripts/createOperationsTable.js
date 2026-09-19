// src/scripts/createOperationsTable.js
// Usage: node src/scripts/createOperationsTable.js
//
// Phase C : module Operations — suivi d'actions/tâches par ville et
// responsable (fait, jusqu'ici, à la main dans l'onglet "Operations" du
// classeur de gestion : Date, Commande/sujet, Ville, Type, Responsable,
// Statut, Échéance, Action/résolution).
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_OPERATIONS = `
  CREATE TABLE IF NOT EXISTS operations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    op_date DATE NOT NULL,
    subject VARCHAR(255) NOT NULL,
    city VARCHAR(120) NULL,
    type VARCHAR(60) NULL,
    responsible_user_id INT NULL,
    status ENUM('OPEN','IN_PROGRESS','DONE') NOT NULL DEFAULT 'OPEN',
    due_date DATE NULL,
    resolution TEXT NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (responsible_user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    INDEX idx_status (status),
    INDEX idx_city (city),
    INDEX idx_op_date (op_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createOperationsTable] creating `operations`...");
  await pool.query(CREATE_OPERATIONS);

  await pool.end();
  console.log("[createOperationsTable] done");
}

main().catch((e) => {
  console.error("[createOperationsTable] FAILED:", e.message || e);
  process.exit(1);
});
