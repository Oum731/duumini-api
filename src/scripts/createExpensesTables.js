// src/scripts/createExpensesTables.js
// Usage: node src/scripts/createExpensesTables.js
//
// Tables `expense_categories` et `expenses`, utilisées par
// src/routes/expense_categories.js et src/routes/expenses.js. Absentes de
// cet environnement (créées à la main sur l'ancienne base de production,
// jamais versionnées). warehouse_id est volontairement omise ici : run
// ensuite addExpensesWarehouseId.js (déjà dans le repo) pour l'ajouter,
// comme prévu par le code défensif d'expenses.js.
//
// Idempotent (IF NOT EXISTS) - safe à relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_EXPENSE_CATEGORIES = `
  CREATE TABLE IF NOT EXISTS expense_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shop_id BIGINT NULL,
    name VARCHAR(120) NOT NULL,
    color VARCHAR(16) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shop_id) REFERENCES shops(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_EXPENSES = `
  CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shop_id BIGINT NULL,
    user_id BIGINT NULL,
    category_id INT NULL,
    category_name VARCHAR(120) NULL,
    label VARCHAR(255) NOT NULL,
    description TEXT NULL,
    amount DECIMAL(12,2) NOT NULL,
    expense_date DATE NOT NULL,
    payment_method VARCHAR(40) NULL,
    status ENUM('PENDING','PAID','CANCELLED') NOT NULL DEFAULT 'PAID',
    reference VARCHAR(120) NULL,
    receipt_url VARCHAR(512) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (shop_id) REFERENCES shops(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES expense_categories(id),
    INDEX idx_expenses_date (expense_date),
    INDEX idx_expenses_shop (shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createExpensesTables] creating `expense_categories`...");
  await pool.query(CREATE_EXPENSE_CATEGORIES);
  console.log("[createExpensesTables] `expense_categories` OK");

  console.log("[createExpensesTables] creating `expenses`...");
  await pool.query(CREATE_EXPENSES);
  console.log("[createExpensesTables] `expenses` OK");

  await pool.end();
  console.log("[createExpensesTables] done");
}

main().catch((e) => {
  console.error("[createExpensesTables] FAILED:", e.message || e);
  process.exit(1);
});
