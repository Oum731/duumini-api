// src/scripts/reorganizeFoodCategories.js
// Usage: node src/scripts/reorganizeFoodCategories.js
//
// Les 16 produits Attiéké/Placali/Poulet fumé étaient répartis dans 3
// catégories (Épiceries #6, Produits alimentaires #10, Ventes de Gros #11)
// selon le FORMAT de conditionnement (sachet vs carton en gros), pas selon
// la vraie nature du produit. Ce script réorganise :
//   1. Crée 3 sous-catégories (Attiéké / Placali / Poulet fumé) sous la
//      catégorie #10 "Produits alimentaires" (vertical MARKET, inchangé).
//   2. Réaffecte les 16 produits à category_id=10 + le bon sub_category_id,
//      selon leur nom.
//   3. Renseigne categories.image_urls (#10) avec un pool de 14 photos
//      propres (sans prix incrusté, vérifiées visuellement une par une) pour
//      un affichage aléatoire côté accueil ; vide l'image des catégories
//      #6/#11 qui n'ont plus de produit.
//
// Idempotent : les sous-catégories sont créées seulement si absentes, les
// UPDATE sont safe à relancer.

require("dotenv").config();
const { getPool } = require("../lib/db");

const FOOD_CATEGORY_ID = 10; // Produits alimentaires (vertical MARKET)
const RETIRED_CATEGORY_IDS = [6, 11]; // Épiceries, Ventes de Gros — plus utilisées par ces produits

const SUB_CATEGORIES = [
  { name: "Attiéké", slug: "attieke", match: "%ttiek%" },
  { name: "Placali", slug: "placali", match: "%lacali%" },
  { name: "Poulet fumé", slug: "poulet-fume", match: "%oulet%" },
];

// Photos vérifiées visuellement (Cloudinary) — aucun prix incrusté dans l'image.
const ATTIEKE_IMAGES = [
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773925917/products/2026/03/500G%20IMAGE%20ATTIEKE.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773884572/products/2026/03/ATTIEKE%2015%20DH.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773926290/products/2026/03/11AZQS23.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773885203/products/2026/03/Attieke%20deshydrat%C3%83%C2%A9%20900g%20new.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773931129/products/2026/03/22.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773930862/products/2026/03/18.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773930755/products/2026/03/17.png",
];

const PLACALI_IMAGES = [
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1782922536/products/2026/07/placali500g.jpg",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1782922594/products/2026/07/placali300g.jpg",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773886071/products/2026/03/FARINE%20DE%20PLACALI%20200G.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1773885579/products/2026/03/farine%20de%20placali%20900G%201.png",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1779323521/products/2026/05/IMG_4995.png",
];

const POULET_IMAGES = [
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1782922478/products/2026/07/pouletfumedr.jpg",
  "https://res.cloudinary.com/dk6mvlzji/image/upload/v1782922479/products/2026/07/pouletfumedv.jpg",
];

const FOOD_CATEGORY_IMAGE_POOL = [...ATTIEKE_IMAGES, ...PLACALI_IMAGES, ...POULET_IMAGES];

async function ensureSubCategory(pool, def) {
  const [[existing]] = await pool.query(
    `SELECT id FROM sub_categories WHERE category_id=? AND slug=? LIMIT 1`,
    [FOOD_CATEGORY_ID, def.slug]
  );
  if (existing) {
    console.log(`[reorganizeFoodCategories] sub_category "${def.name}" already exists (#${existing.id})`);
    return existing.id;
  }
  const [r] = await pool.query(
    `INSERT INTO sub_categories (category_id, name, slug, vertical) VALUES (?, ?, ?, 'MARKET')`,
    [FOOD_CATEGORY_ID, def.name, def.slug]
  );
  console.log(`[reorganizeFoodCategories] created sub_category "${def.name}" (#${r.insertId})`);
  return r.insertId;
}

async function main() {
  const pool = getPool();

  console.log("[reorganizeFoodCategories] ensuring sub-categories...");
  const subCategoryIds = {};
  for (const def of SUB_CATEGORIES) {
    subCategoryIds[def.slug] = await ensureSubCategory(pool, def);
  }

  console.log("[reorganizeFoodCategories] reassigning products...");
  for (const def of SUB_CATEGORIES) {
    const [r] = await pool.query(
      `UPDATE products SET category_id=?, sub_category_id=? WHERE name LIKE ?`,
      [FOOD_CATEGORY_ID, subCategoryIds[def.slug], def.match]
    );
    console.log(`[reorganizeFoodCategories] "${def.name}" -> affectedRows=${r.affectedRows}`);
  }

  console.log("[reorganizeFoodCategories] updating category images...");
  const [rFood] = await pool.query(`UPDATE categories SET image_url=?, image_urls=? WHERE id=?`, [
    FOOD_CATEGORY_IMAGE_POOL[0],
    JSON.stringify(FOOD_CATEGORY_IMAGE_POOL),
    FOOD_CATEGORY_ID,
  ]);
  console.log(`[reorganizeFoodCategories] category #${FOOD_CATEGORY_ID} image pool set (${FOOD_CATEGORY_IMAGE_POOL.length} photos) — affectedRows=${rFood.affectedRows}`);

  for (const id of RETIRED_CATEGORY_IDS) {
    const [r] = await pool.query(`UPDATE categories SET image_url=NULL, image_urls=NULL WHERE id=?`, [id]);
    console.log(`[reorganizeFoodCategories] category #${id} image cleared — affectedRows=${r.affectedRows}`);
  }

  await pool.end();
  console.log("[reorganizeFoodCategories] done");
}

main().catch((e) => {
  console.error("[reorganizeFoodCategories] FAILED:", e.message || e);
  process.exit(1);
});
