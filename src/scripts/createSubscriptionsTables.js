// src/scripts/createSubscriptionsTables.js
// Usage: node src/scripts/createSubscriptionsTables.js
//
// Module Abonnements (Phase 4) : permet à une entreprise (table `companies`,
// voir createCompaniesTables.js) de souscrire à un plan payant pour débloquer
// les outils de gestion Duumini. V1 volontairement simple : pas de
// passerelle de paiement, l'admin active/renouvelle/annule à la main
// (mêmes conventions que les paiements RIB/cash déjà gérés côté commandes).
// Aucune restriction d'accès n'est branchée sur les pages existantes pour
// l'instant — ce script pose juste le modèle de données et l'historique.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_SUBSCRIPTION_PLANS = `
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(40) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    price_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_currency VARCHAR(8) NOT NULL DEFAULT 'MAD',
    billing_cycle ENUM('MONTHLY','YEARLY') NOT NULL DEFAULT 'MONTHLY',
    trial_days INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_subscription_plans_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_COMPANY_SUBSCRIPTIONS = `
  CREATE TABLE IF NOT EXISTS company_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    plan_id INT NULL,
    status ENUM('TRIAL','ACTIVE','EXPIRED','CANCELLED') NOT NULL DEFAULT 'TRIAL',
    trial_ends_at DATE NULL,
    current_period_end DATE NULL,
    activated_by INT NULL,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id),
    FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
    FOREIGN KEY (activated_by) REFERENCES users(id),
    UNIQUE KEY uq_company_subscriptions_company (company_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_COMPANY_SUBSCRIPTION_EVENTS = `
  CREATE TABLE IF NOT EXISTS company_subscription_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    event_type ENUM('TRIAL_STARTED','ACTIVATED','RENEWED','EXPIRED','CANCELLED','PLAN_CHANGED') NOT NULL,
    plan_id INT NULL,
    performed_by INT NULL,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id),
    FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
    FOREIGN KEY (performed_by) REFERENCES users(id),
    INDEX idx_company (company_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const pool = getPool();

  console.log("[createSubscriptionsTables] creating `subscription_plans`...");
  await pool.query(CREATE_SUBSCRIPTION_PLANS);

  console.log("[createSubscriptionsTables] creating `company_subscriptions`...");
  await pool.query(CREATE_COMPANY_SUBSCRIPTIONS);

  console.log("[createSubscriptionsTables] creating `company_subscription_events`...");
  await pool.query(CREATE_COMPANY_SUBSCRIPTION_EVENTS);

  await pool.end();
  console.log("[createSubscriptionsTables] done");
}

main().catch((e) => {
  console.error("[createSubscriptionsTables] FAILED:", e.message || e);
  process.exit(1);
});
