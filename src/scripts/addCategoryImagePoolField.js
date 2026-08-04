// src/scripts/addCategoryImagePoolField.js
// Usage: node src/scripts/addCategoryImagePoolField.js
// Ajoute une colonne image_urls (TEXT, tableau JSON) sur categories, pour
// permettre d'afficher une photo tirée au hasard parmi plusieurs candidates
// propres (sans prix) à chaque chargement de la page d'accueil. La colonne
// image_url existante reste comme repli simple pour les catégories sans pool.
// Idempotent (ADD COLUMN IF NOT EXISTS), safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function main() {
  const pool = getPool();
  console.log("[addCategoryImagePoolField] adding categories.image_urls...");
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_urls TEXT NULL`);
  console.log("[addCategoryImagePoolField] done");
  await pool.end();
}

main().catch((e) => {
  console.error("[addCategoryImagePoolField] FAILED:", e.message || e);
  process.exit(1);
});
