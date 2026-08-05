// src/scripts/migrateToDocCategories.js
// Exécuté le 2026-08-05 — archive du script de migration (déjà appliqué en
// base, ne pas relancer tel quel : les ids RENAMES/DELETE_IDS ci-dessous
// correspondent à l'état constaté ce jour-là).
//
// Aligne les catégories sur les 6 prévues par le document de référence
// (Alimentation, Boissons, Épices, Cosmétique, Artisanat, Mode) :
//  - Renomme "Produits alimentaires" (id=10, 16 produits) -> "Alimentation"
//    (même id, donc les produits restent attachés sans rien toucher côté
//    products.category_id).
//  - Renomme "Fashion & Style" (id=12, vide) -> "Mode".
//  - "Boissons" (id=8) déjà conforme, inchangée.
//  - Crée 3 catégories vides : Épices, Cosmétique, Artisanat.
//  - Supprime les 5 catégories vides hors périmètre du document (Plat,
//    Épiceries, Général, Produits naturels, Ventes de Gros) ; leurs
//    sous-catégories partent en CASCADE (fk_sub_categories_category).
//    Vérifié au préalable : 0 produit rattaché à ces 5 catégories
//    (fk_products_category est en SET NULL de toute façon, donc même en cas
//    d'oubli aucun produit ne serait perdu, juste décatégorisé).
require("dotenv").config();
const { getPool } = require("../lib/db");

const RENAMES = [
  { id: 10, name: "Alimentation", slug: "alimentation" },
  { id: 12, name: "Mode", slug: "mode" },
];

const CREATES = [
  { name: "Épices", slug: "epices", vertical: "MARKET" },
  { name: "Cosmétique", slug: "cosmetique", vertical: "MARKET" },
  { name: "Artisanat", slug: "artisanat", vertical: "MARKET" },
];

const DELETE_IDS = [21, 6, 1, 7, 11]; // Plat, Épiceries, Général, Produits naturels, Ventes de Gros

async function main() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Garde-fou : re-vérifie qu'aucun produit ne dépend des catégories à
    // supprimer avant de les supprimer (protection contre un état différent
    // de celui inspecté juste avant).
    const [[{ n: orphanCount }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM products WHERE category_id IN (${DELETE_IDS.map(() => "?").join(",")})`,
      DELETE_IDS
    );
    if (orphanCount > 0) {
      throw new Error(
        `Abandon : ${orphanCount} produit(s) rattaché(s) aux catégories à supprimer (${DELETE_IDS.join(",")}). Vérifie manuellement avant de relancer.`
      );
    }

    for (const r of RENAMES) {
      const [res] = await conn.query(
        `UPDATE categories SET name = ?, slug = ? WHERE id = ?`,
        [r.name, r.slug, r.id]
      );
      console.log(`Renommée id=${r.id} -> "${r.name}" (affected=${res.affectedRows})`);
    }

    for (const c of CREATES) {
      const [res] = await conn.query(
        `INSERT INTO categories (name, slug, vertical) VALUES (?, ?, ?)`,
        [c.name, c.slug, c.vertical]
      );
      console.log(`Créée "${c.name}" (id=${res.insertId})`);
    }

    const [delRes] = await conn.query(
      `DELETE FROM categories WHERE id IN (${DELETE_IDS.map(() => "?").join(",")})`,
      DELETE_IDS
    );
    console.log(`Supprimées ${delRes.affectedRows} catégorie(s) (ids: ${DELETE_IDS.join(",")})`);

    await conn.commit();

    const [finalCats] = await conn.query(
      `SELECT id, name, slug, vertical FROM categories ORDER BY name`
    );
    console.log("\n=== État final ===");
    console.table(finalCats);

    const [prodCheck] = await conn.query(
      `SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id`
    );
    console.log("=== Répartition produits par category_id ===");
    console.table(prodCheck);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e.message);
  process.exitCode = 1;
});
