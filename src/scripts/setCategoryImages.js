// src/scripts/setCategoryImages.js
// Usage: node src/scripts/setCategoryImages.js
// Renseigne l'image de chaque catégorie ayant des produits actifs, avec une
// photo produit existante vérifiée visuellement (Cloudinary, déjà présente
// dans product_images — aucun nouvel upload). Alimente la section "Nos
// catégories" de l'accueil (src/pages/home/CategoriesSection.tsx côté
// duumini-web), qui affichait jusqu'ici des tuiles codées en dur
// déconnectées des vraies catégories.
//
// Idempotent (UPDATE simple par id), safe à relancer. Les catégories sans
// produit (Plat, Boissons, Général, Produits naturels, Fashion & Style)
// n'ont pas de photo disponible — non traitées ici, resteront sans image
// tant qu'elles n'ont pas de produit.

require("dotenv").config();
const { getPool } = require("../lib/db");

const CATEGORY_IMAGES = [
  {
    id: 6, // Épiceries
    name: "Épiceries",
    image_url:
      "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773925917/products/2026/03/500G%20IMAGE%20ATTIEKE.png",
  },
  {
    id: 10, // Produits alimentaires
    name: "Produits alimentaires",
    image_url:
      "https://res.cloudinary.com/dk6mvlzji/image/upload/v1782922536/products/2026/07/placali500g.jpg",
  },
  {
    id: 11, // Ventes de Gros
    name: "Ventes de Gros",
    image_url:
      "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773930753/products/2026/03/16.png",
  },
];

async function main() {
  const pool = getPool();

  console.log("[setCategoryImages] updating category images...");
  for (const cat of CATEGORY_IMAGES) {
    const [r] = await pool.query(`UPDATE categories SET image_url = ? WHERE id = ?`, [
      cat.image_url,
      cat.id,
    ]);
    console.log(
      `[setCategoryImages] category #${cat.id} (${cat.name}) — affectedRows=${r.affectedRows}`
    );
  }

  await pool.end();
  console.log("[setCategoryImages] done");
}

main().catch((e) => {
  console.error("[setCategoryImages] FAILED:", e.message || e);
  process.exit(1);
});
