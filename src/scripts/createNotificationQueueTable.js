// src/scripts/createNotificationQueueTable.js
// Usage: node src/scripts/createNotificationQueueTable.js
//
// Table `notification_queue` (src/routes/orders.js, src/routes/products.js,
// src/workers/notificationWorker.js), jamais créée jusqu'ici. Reconstruite
// de zéro (décision du 2026-11-18). Dépend de `users`.
//
// Idempotent (CREATE TABLE IF NOT EXISTS) - safe à relancer.
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { tableExists, ensureColumns } = require("./_schemaUtils");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS notification_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    type VARCHAR(60) NOT NULL,
    payload JSON NULL,
    status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    error_text VARCHAR(500) NULL,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_notification_queue_status (status, id),
    INDEX idx_notification_queue_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { name: "user_id", sql: "ALTER TABLE notification_queue ADD COLUMN user_id BIGINT NOT NULL" },
  { name: "type", sql: "ALTER TABLE notification_queue ADD COLUMN type VARCHAR(60) NOT NULL" },
  { name: "payload", sql: "ALTER TABLE notification_queue ADD COLUMN payload JSON NULL" },
  { name: "status", sql: "ALTER TABLE notification_queue ADD COLUMN status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued'" },
  { name: "attempts", sql: "ALTER TABLE notification_queue ADD COLUMN attempts INT NOT NULL DEFAULT 0" },
  { name: "error_text", sql: "ALTER TABLE notification_queue ADD COLUMN error_text VARCHAR(500) NULL" },
  { name: "sent_at", sql: "ALTER TABLE notification_queue ADD COLUMN sent_at TIMESTAMP NULL" },
  { name: "created_at", sql: "ALTER TABLE notification_queue ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const existed = await tableExists(pool, "notification_queue");
  console.log("[createNotificationQueueTable] creating `notification_queue`...");
  await pool.query(CREATE_SQL);
  console.log("[createNotificationQueueTable] `notification_queue` OK");

  if (existed) {
    await ensureColumns(pool, "notification_queue", REQUIRED_COLUMNS, "[createNotificationQueueTable]");
  }

  await pool.end();
  console.log("[createNotificationQueueTable] done");
}

main().catch((e) => {
  console.error("[createNotificationQueueTable] FAILED:", e.message || e);
  process.exit(1);
});
