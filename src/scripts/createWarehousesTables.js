// src/scripts/createWarehousesTables.js
// Usage: node src/scripts/createWarehousesTables.js
//
// Fondations du module Stock & Entrepôts :
//  - warehouses          : les entrepôts (1 seul aujourd'hui : Sidi Moumen)
//  - warehouse_managers  : affectation d'un utilisateur comme gestionnaire
//                          d'un entrepôt (fait par l'admin)
//  - warehouse_stock     : quantité en stock par entrepôt/produit/variante
//                          (remplace le compteur unique products.stock /
//                          product_variants.stock comme source de vérité)
//  - stock_movements     : journal (ledger) de tous les mouvements — chaque
//                          vente, annulation, réception fournisseur ou
//                          correction manuelle y laisse une trace
//
// Ce script crée les tables, seed l'entrepôt de Sidi Moumen, puis backfill
// warehouse_stock à partir des stocks produits/variantes existants pour ne
// perdre aucune donnée. Idempotent : peut être relancé sans dupliquer les
// données (seed via INSERT IGNORE, backfill via INSERT ... ON DUPLICATE).
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_WAREHOUSES = `
  CREATE TABLE IF NOT EXISTS warehouses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    code VARCHAR(32) NOT NULL,
    address VARCHAR(255) NULL,
    city VARCHAR(120) NULL,
    country_code VARCHAR(4) NOT NULL DEFAULT 'MA',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_warehouses_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_WAREHOUSE_MANAGERS = `
  CREATE TABLE IF NOT EXISTS warehouse_managers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    user_id INT NOT NULL,
    assigned_by INT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (assigned_by) REFERENCES users(id),
    UNIQUE KEY uq_warehouse_user (warehouse_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_WAREHOUSE_STOCK = `
  CREATE TABLE IF NOT EXISTS warehouse_stock (
    id INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    product_id INT NOT NULL,
    variant_id INT NULL,
    quantity INT NOT NULL DEFAULT 0,
    min_threshold INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    INDEX idx_wh_product (warehouse_id, product_id),
    INDEX idx_wh_variant (warehouse_id, variant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;
// Pas d'UNIQUE KEY(warehouse_id, product_id, variant_id) : MySQL considère
// chaque NULL distinct dans une contrainte UNIQUE, donc pour les produits
// sans variante (variant_id NULL) elle ne protégerait pas contre les
// doublons. La non-duplication est garantie côté application par
// upsertWarehouseStock (SELECT ... FOR UPDATE avant écriture), pas par le
// schéma — voir src/lib/stockLedger.js.

const CREATE_STOCK_MOVEMENTS = `
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    warehouse_id INT NOT NULL,
    product_id INT NULL,
    variant_id INT NULL,
    type ENUM(
      'IN_PURCHASE','IN_RETURN_CANCEL','IN_ADJUSTMENT',
      'OUT_SALE','OUT_ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT'
    ) NOT NULL,
    qty INT NOT NULL,
    unit_cost DECIMAL(10,2) NULL,
    reference_type ENUM('ORDER','SUPPLIER_DELIVERY','MANUAL','TRANSFER') NOT NULL DEFAULT 'MANUAL',
    reference_id INT NULL,
    performed_by INT NULL,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (performed_by) REFERENCES users(id),
    INDEX idx_wh_product (warehouse_id, product_id),
    INDEX idx_type (type),
    INDEX idx_reference (reference_type, reference_id),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const SEED_SIDI_MOUMEN = `
  INSERT IGNORE INTO warehouses (name, code, address, city, country_code, is_active)
  VALUES ('Entrepôt Sidi Moumen', 'SIDI-MOUMEN', 'Sidi Moumen', 'Casablanca', 'MA', 1)
`;

async function backfillWarehouseStock(pool, warehouseId) {
  console.log("[createWarehousesTables] backfill warehouse_stock (produits sans variante)...");
  await pool.query(
    `
      INSERT INTO warehouse_stock (warehouse_id, product_id, variant_id, quantity)
      SELECT ?, p.id, NULL, COALESCE(p.stock, 0)
      FROM products p
      WHERE NOT EXISTS (
        SELECT 1 FROM warehouse_stock ws
        WHERE ws.warehouse_id = ? AND ws.product_id = p.id AND ws.variant_id IS NULL
      )
    `,
    [warehouseId, warehouseId],
  );

  console.log("[createWarehousesTables] backfill warehouse_stock (variantes)...");
  await pool.query(
    `
      INSERT INTO warehouse_stock (warehouse_id, product_id, variant_id, quantity)
      SELECT ?, v.product_id, v.id, COALESCE(v.stock, 0)
      FROM product_variants v
      WHERE NOT EXISTS (
        SELECT 1 FROM warehouse_stock ws
        WHERE ws.warehouse_id = ? AND ws.variant_id = v.id
      )
    `,
    [warehouseId, warehouseId],
  );
}

async function main() {
  const pool = getPool();

  console.log("[createWarehousesTables] creating `warehouses`...");
  await pool.query(CREATE_WAREHOUSES);

  console.log("[createWarehousesTables] creating `warehouse_managers`...");
  await pool.query(CREATE_WAREHOUSE_MANAGERS);

  console.log("[createWarehousesTables] creating `warehouse_stock`...");
  await pool.query(CREATE_WAREHOUSE_STOCK);

  console.log("[createWarehousesTables] creating `stock_movements`...");
  await pool.query(CREATE_STOCK_MOVEMENTS);

  console.log("[createWarehousesTables] seeding Sidi Moumen...");
  await pool.query(SEED_SIDI_MOUMEN);

  const [[warehouse]] = await pool.query(
    `SELECT id FROM warehouses WHERE code = 'SIDI-MOUMEN' LIMIT 1`,
  );

  if (warehouse?.id) {
    await backfillWarehouseStock(pool, Number(warehouse.id));
  } else {
    console.warn("[createWarehousesTables] Sidi Moumen introuvable, backfill ignoré");
  }

  await pool.end();
  console.log("[createWarehousesTables] done");
}

main().catch((e) => {
  console.error("[createWarehousesTables] FAILED:", e.message || e);
  process.exit(1);
});
