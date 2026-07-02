// src/scripts/createCountryConfigTable.js
// Usage: node src/scripts/createCountryConfigTable.js
// Crée la table `country_config` (Phase 2 de la refonte Duumini 2.0) et la
// pré-remplit avec les corridors actuels (Maroc/Côte d'Ivoire actifs) et la
// feuille de route CEDEAO (à venir) déjà affichée en dur sur /pays. Ajouter
// un nouveau pays ensuite ne nécessite plus qu'une insertion dans cette
// table, plus de modification de code (routes/shops.js, PaysPage.tsx...).
//
// Idempotent : CREATE TABLE IF NOT EXISTS + INSERT ... ON DUPLICATE KEY
// UPDATE. Safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS country_config (
  code CHAR(2) PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'MAD',
  flag_emoji VARCHAR(16) NULL,
  description TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const SEED_ROWS = [
  {
    code: "MA",
    label: "Maroc",
    currency: "MAD",
    flag_emoji: "🇲🇦",
    description: "Notre premier marché, aujourd'hui opérationnel de bout en bout.",
    is_active: 1,
    sort_order: 1,
  },
  {
    code: "CI",
    label: "Côte d'Ivoire",
    currency: "XOF",
    flag_emoji: "🇨🇮",
    description:
      "Premier corridor ouvert (Maroc ↔ Côte d'Ivoire) : vendeurs, fournisseurs et acheteurs peuvent commander et suivre leurs échanges de bout en bout.",
    is_active: 1,
    sort_order: 2,
  },
  {
    code: "SN",
    label: "Sénégal",
    currency: "XOF",
    flag_emoji: "🇸🇳",
    description:
      "Proximité culturelle et linguistique avec la Côte d'Ivoire, écosystème de paiement mobile mature — une extension naturelle du corridor actuel.",
    is_active: 0,
    sort_order: 3,
  },
  {
    code: "CM",
    label: "Cameroun",
    currency: "XAF",
    flag_emoji: "🇨🇲",
    description: "Un hub logistique clé pour desservir l'Afrique centrale.",
    is_active: 0,
    sort_order: 4,
  },
  {
    code: "TN",
    label: "Tunisie",
    currency: "TND",
    flag_emoji: "🇹🇳",
    description: "Extension naturelle vers le Maghreb depuis le Maroc.",
    is_active: 0,
    sort_order: 5,
  },
  {
    code: "DZ",
    label: "Algérie",
    currency: "DZD",
    flag_emoji: "🇩🇿",
    description: "Extension naturelle vers le Maghreb depuis le Maroc.",
    is_active: 0,
    sort_order: 6,
  },
  {
    code: "NG",
    label: "Nigeria",
    currency: "NGN",
    flag_emoji: "🇳🇬",
    description:
      "Un des plus grands marchés potentiels de la zone, avec une ouverture progressive vers l'Afrique anglophone.",
    is_active: 0,
    sort_order: 7,
  },
  {
    code: "GH",
    label: "Ghana",
    currency: "GHS",
    flag_emoji: "🇬🇭",
    description:
      "Un des plus grands marchés potentiels de la zone, avec une ouverture progressive vers l'Afrique anglophone.",
    is_active: 0,
    sort_order: 8,
  },
];

const UPSERT_ROW = `
INSERT INTO country_config (code, label, currency, flag_emoji, description, is_active, sort_order)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  currency = VALUES(currency),
  flag_emoji = VALUES(flag_emoji),
  description = VALUES(description),
  is_active = VALUES(is_active),
  sort_order = VALUES(sort_order)
`;

async function main() {
  const pool = getPool();

  console.log("[createCountryConfigTable] creating `country_config`...");
  await pool.query(CREATE_TABLE);
  console.log("[createCountryConfigTable] `country_config` OK");

  console.log("[createCountryConfigTable] seeding rows...");
  for (const row of SEED_ROWS) {
    await pool.query(UPSERT_ROW, [
      row.code,
      row.label,
      row.currency,
      row.flag_emoji,
      row.description,
      row.is_active,
      row.sort_order,
    ]);
  }
  console.log(`[createCountryConfigTable] seeded ${SEED_ROWS.length} rows`);

  await pool.end();
  console.log("[createCountryConfigTable] done");
}

main().catch((e) => {
  console.error("[createCountryConfigTable] FAILED:", e.message || e);
  process.exit(1);
});
