// src/scripts/createSupplierDeliveriesTables.js
// Usage: node src/scripts/createSupplierDeliveriesTables.js
//
// Traçabilité fournisseurs : chaque réception de marchandise en entrepôt
// devient une "livraison fournisseur" avec ses lignes (produit, quantité,
// coût unitaire réel de cet achat). Chaque ligne génère un mouvement
// IN_PURCHASE dans stock_movements (voir src/lib/stockLedger.js), référencé
// vers cette livraison — on peut donc remonter de n'importe quelle unité en
// stock jusqu'au fournisseur, à la livraison et au prix d'achat exacts.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_SUPPLIER_DELIVERIES = `
  CREATE TABLE IF NOT EXISTS supplier_deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_shop_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    reference VARCHAR(120) NULL,
    status ENUM('RECEIVED','CANCELLED') NOT NULL DEFAULT 'RECEIVED',
    received_by INT NULL,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_shop_id) REFERENCES shops(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (received_by) REFERENCES users(id),
    INDEX idx_supplier (supplier_shop_id),
    INDEX idx_warehouse (warehouse_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_SUPPLIER_DELIVERY_ITEMS = `
  CREATE TABLE IF NOT EXISTS supplier_delivery_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    delivery_id INT NOT NULL,
    product_id INT NOT NULL,
    variant_id INT NULL,
    qty INT NOT NULL,
    unit_cost DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES supplier_deliveries(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    INDEX idx_delivery (delivery_id),
    INDEX idx_product (product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createSupplierDeliveriesTables] creating `supplier_deliveries`...");
  await pool.query(CREATE_SUPPLIER_DELIVERIES);

  console.log("[createSupplierDeliveriesTables] creating `supplier_delivery_items`...");
  await pool.query(CREATE_SUPPLIER_DELIVERY_ITEMS);

  await pool.end();
  console.log("[createSupplierDeliveriesTables] done");
}

main().catch((e) => {
  console.error("[createSupplierDeliveriesTables] FAILED:", e.message || e);
  process.exit(1);
});
