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
const { tableExists, ensureColumns } = require("./_schemaUtils");

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

const REQUIRED_EXPENSE_CATEGORIES_COLUMNS = [
  { name: "shop_id", sql: "ALTER TABLE expense_categories ADD COLUMN shop_id BIGINT NULL" },
  { name: "name", sql: "ALTER TABLE expense_categories ADD COLUMN name VARCHAR(120) NOT NULL" },
  { name: "color", sql: "ALTER TABLE expense_categories ADD COLUMN color VARCHAR(16) NULL" },
  { name: "is_active", sql: "ALTER TABLE expense_categories ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "ALTER TABLE expense_categories ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
];

const REQUIRED_EXPENSES_COLUMNS = [
  { name: "shop_id", sql: "ALTER TABLE expenses ADD COLUMN shop_id BIGINT NULL" },
  { name: "user_id", sql: "ALTER TABLE expenses ADD COLUMN user_id BIGINT NULL" },
  { name: "category_id", sql: "ALTER TABLE expenses ADD COLUMN category_id INT NULL" },
  { name: "category_name", sql: "ALTER TABLE expenses ADD COLUMN category_name VARCHAR(120) NULL" },
  { name: "label", sql: "ALTER TABLE expenses ADD COLUMN label VARCHAR(255) NOT NULL" },
  { name: "description", sql: "ALTER TABLE expenses ADD COLUMN description TEXT NULL" },
  { name: "amount", sql: "ALTER TABLE expenses ADD COLUMN amount DECIMAL(12,2) NOT NULL" },
  { name: "expense_date", sql: "ALTER TABLE expenses ADD COLUMN expense_date DATE NOT NULL" },
  { name: "payment_method", sql: "ALTER TABLE expenses ADD COLUMN payment_method VARCHAR(40) NULL" },
  { name: "status", sql: "ALTER TABLE expenses ADD COLUMN status ENUM('PENDING','PAID','CANCELLED') NOT NULL DEFAULT 'PAID'" },
  { name: "reference", sql: "ALTER TABLE expenses ADD COLUMN reference VARCHAR(120) NULL" },
  { name: "receipt_url", sql: "ALTER TABLE expenses ADD COLUMN receipt_url VARCHAR(512) NULL" },
  { name: "created_at", sql: "ALTER TABLE expenses ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
  { name: "updated_at", sql: "ALTER TABLE expenses ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" },
];

async function main() {
  const pool = getPool();

  const categoriesExisted = await tableExists(pool, "expense_categories");
  console.log("[createExpensesTables] creating `expense_categories`...");
  await pool.query(CREATE_EXPENSE_CATEGORIES);
  console.log("[createExpensesTables] `expense_categories` OK");
  if (categoriesExisted) {
    await ensureColumns(pool, "expense_categories", REQUIRED_EXPENSE_CATEGORIES_COLUMNS, "[createExpensesTables]");
  }

  const expensesExisted = await tableExists(pool, "expenses");
  console.log("[createExpensesTables] creating `expenses`...");
  await pool.query(CREATE_EXPENSES);
  console.log("[createExpensesTables] `expenses` OK");
  if (expensesExisted) {
    await ensureColumns(pool, "expenses", REQUIRED_EXPENSES_COLUMNS, "[createExpensesTables]");
  }

  await pool.end();
  console.log("[createExpensesTables] done");
}

main().catch((e) => {
  console.error("[createExpensesTables] FAILED:", e.message || e);
  process.exit(1);
});
