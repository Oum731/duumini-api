// src/scripts/addCategoryImageField.js
// Usage: node src/scripts/addCategoryImageField.js
// Ajoute une image représentative par catégorie (affichée sur la section
// "Nos catégories" de l'accueil, cf. src/pages/home/CategoriesSection.tsx
// côté duumini-web) — jusqu'ici aucune catégorie n'avait d'image, la page
// d'accueil utilisait une liste de tuiles codées en dur et déconnectée des
// vraies catégories.
//
// Additif uniquement, aucune ligne existante affectée.

require("dotenv").config();
const { getPool } = require("../lib/db");

const ALTER_SQL = `
  ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS image_url VARCHAR(500) NULL
`;

async function main() {
  const pool = getPool();

  console.log("[addCategoryImageField] altering `categories`...");
  await pool.query(ALTER_SQL);
  console.log("[addCategoryImageField] `categories` OK (image_url)");

  await pool.end();
  console.log("[addCategoryImageField] done");
}

main().catch((e) => {
  console.error("[addCategoryImageField] FAILED:", e.message || e);
  process.exit(1);
});
