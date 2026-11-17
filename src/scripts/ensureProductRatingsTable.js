// src/scripts/ensureProductRatingsTable.js
// Usage: node src/scripts/ensureProductRatingsTable.js
//
// Table `product_ratings`, utilisée par src/routes/productRatings.js.
// Présente dans cet environnement (import Hostinger) mais avec un schéma
// incomplet - au moins `product_id` manquant ("Unknown column 'product_id'
// in 'field list'"). Ce script crée la table si elle est totalement
// absente, puis complète les colonnes manquantes une par une (ADD COLUMN
// IF NOT EXISTS non supporté par ce serveur -> vérif INFORMATION_SCHEMA,
// même pattern que les autres scripts add*.js). Ajoute aussi la contrainte
// UNIQUE (product_id, user_id) requise par l'UPSERT de la route POST
// /:id/rate, si elle n'existe pas déjà.
//
// Idempotent - safe à relancer. N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function tableExists(pool, table) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

async function uniqueKeyExists(pool, table, columns) {
  const [rows] = await pool.query(
    `
    SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME
    `,
    [table],
  );
  const target = columns.slice().sort().join(",");
  return rows.some((r) => (r.cols || "").split(",").sort().join(",") === target);
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS product_ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    rating TINYINT NOT NULL,
    comment TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_product_ratings_product_user (product_id, user_id),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_product_ratings_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const REQUIRED_COLUMNS = [
  { column: "product_id", sql: "ALTER TABLE product_ratings ADD COLUMN product_id BIGINT NOT NULL" },
  { column: "user_id", sql: "ALTER TABLE product_ratings ADD COLUMN user_id BIGINT NOT NULL" },
  { column: "rating", sql: "ALTER TABLE product_ratings ADD COLUMN rating TINYINT NOT NULL DEFAULT 5" },
  { column: "comment", sql: "ALTER TABLE product_ratings ADD COLUMN comment TEXT NULL" },
  { column: "created_at", sql: "ALTER TABLE product_ratings ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { column: "updated_at", sql: "ALTER TABLE product_ratings ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  if (!(await tableExists(pool, "product_ratings"))) {
    console.log("[ensureProductRatingsTable] creating `product_ratings`...");
    await pool.query(CREATE_SQL);
    console.log("[ensureProductRatingsTable] `product_ratings` OK");
  } else {
    console.log("[ensureProductRatingsTable] `product_ratings` existe déjà, vérification des colonnes...");
    for (const { column, sql } of REQUIRED_COLUMNS) {
      if (await columnExists(pool, "product_ratings", column)) {
        console.log(`[ensureProductRatingsTable] ${column} already exists, skipping`);
        continue;
      }
      console.log(`[ensureProductRatingsTable] adding ${column}...`);
      await pool.query(sql);
      console.log(`[ensureProductRatingsTable] ${column} OK`);
    }

    if (await uniqueKeyExists(pool, "product_ratings", ["product_id", "user_id"])) {
      console.log("[ensureProductRatingsTable] contrainte UNIQUE (product_id, user_id) déjà présente");
    } else {
      console.log("[ensureProductRatingsTable] ajout de la contrainte UNIQUE (product_id, user_id)...");
      try {
        await pool.query(
          "ALTER TABLE product_ratings ADD UNIQUE KEY uniq_product_ratings_product_user (product_id, user_id)",
        );
        console.log("[ensureProductRatingsTable] contrainte UNIQUE OK");
      } catch (e) {
        console.warn(
          "[ensureProductRatingsTable] impossible d'ajouter la contrainte UNIQUE (doublons existants ?) :",
          e.message || e,
        );
        console.warn(
          "[ensureProductRatingsTable] l'UPSERT de POST /:id/rate risque de créer des doublons tant que ce n'est pas corrigé à la main.",
        );
      }
    }
  }

  await pool.end();
  console.log("[ensureProductRatingsTable] done");
}

main().catch((e) => {
  console.error("[ensureProductRatingsTable] FAILED:", e.message || e);
  process.exit(1);
});
