// src/scripts/backfillProductVertical.js
// Usage: node src/scripts/backfillProductVertical.js
//
// addProductVerticalAndPromoFields.js a ajouté products.vertical (ENUM
// FOOD/MARKET/FASHION), NULL par défaut, SANS rétro-remplir les produits
// déjà existants. Résultat : toutes les pages qui filtrent sur
// p.vertical = 'MARKET'/'FOOD' (african-market, african-food...) ne
// trouvent pas certains produits historiques, même quand ils existent
// bel et bien.
//
// `categories.vertical` n'existe pas sur cette base (contrairement à ce
// qu'un script archivé supposait) : on déduit donc le vertical de chaque
// produit encore NULL à partir du vertical déjà majoritairement renseigné
// sur les autres produits de la même category_id (la grande majorité des
// produits ont déjà un vertical correct, posé à la création). Idempotent -
// ne touche que les produits dont vertical est encore NULL, safe à
// relancer.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function main() {
  const pool = getPool();

  const [[{ n: before }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM products WHERE vertical IS NULL`,
  );
  console.log(`[backfillProductVertical] ${before} produit(s) avec vertical NULL avant backfill`);

  if (before === 0) {
    await pool.end();
    console.log("[backfillProductVertical] rien à faire, done");
    return;
  }

  const [groups] = await pool.query(`
    SELECT category_id, vertical, COUNT(*) AS cnt
      FROM products
     WHERE category_id IS NOT NULL AND vertical IS NOT NULL
     GROUP BY category_id, vertical
  `);

  const dominantByCategory = new Map();
  for (const row of groups) {
    const cid = Number(row.category_id);
    const prev = dominantByCategory.get(cid);
    if (!prev || row.cnt > prev.cnt) {
      dominantByCategory.set(cid, { vertical: row.vertical, cnt: row.cnt });
    }
  }
  console.log(`[backfillProductVertical] vertical dominant déduit pour ${dominantByCategory.size} catégorie(s)`);

  let updated = 0;
  for (const [categoryId, { vertical }] of dominantByCategory) {
    const [result] = await pool.query(
      `UPDATE products SET vertical = ? WHERE category_id = ? AND vertical IS NULL`,
      [vertical, categoryId],
    );
    updated += result.affectedRows;
  }
  console.log(`[backfillProductVertical] ${updated} produit(s) mis à jour depuis le vertical dominant de leur catégorie`);

  const [[{ n: after }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM products WHERE vertical IS NULL`,
  );
  if (after > 0) {
    const [stragglers] = await pool.query(
      `SELECT id, name, category_id FROM products WHERE vertical IS NULL LIMIT 20`,
    );
    console.log(
      `[backfillProductVertical] ${after} produit(s) encore sans vertical (category_id NULL, ou catégorie où aucun autre produit n'a de vertical) :`,
    );
    console.table(stragglers);
    console.log("[backfillProductVertical] à corriger manuellement si besoin (UPDATE products SET vertical=... WHERE id=...)");
  } else {
    console.log("[backfillProductVertical] tous les produits ont désormais un vertical");
  }

  await pool.end();
  console.log("[backfillProductVertical] done");
}

main().catch((e) => {
  console.error("[backfillProductVertical] FAILED:", e.message || e);
  process.exit(1);
});
