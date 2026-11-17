// src/scripts/backfillProductVertical.js
// Usage: node src/scripts/backfillProductVertical.js
//
// addProductVerticalAndPromoFields.js a ajouté products.vertical (ENUM
// FOOD/MARKET/FASHION), NULL par défaut, SANS rétro-remplir les produits
// déjà existants. Résultat : toutes les pages qui filtrent sur
// p.vertical = 'MARKET'/'FOOD' (african-market, african-food...) ne
// trouvent aucun produit historique, même quand ils existent bel et bien.
//
// `categories.vertical` existe depuis l'ancienne base et est fiable : on
// s'en sert pour déduire products.vertical via category_id. Idempotent -
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

  const [result] = await pool.query(`
    UPDATE products p
    JOIN categories c ON c.id = p.category_id
       SET p.vertical = c.vertical
     WHERE p.vertical IS NULL
       AND c.vertical IS NOT NULL
  `);
  console.log(`[backfillProductVertical] ${result.affectedRows} produit(s) mis à jour depuis categories.vertical`);

  const [[{ n: after }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM products WHERE vertical IS NULL`,
  );
  if (after > 0) {
    console.log(
      `[backfillProductVertical] ${after} produit(s) encore sans vertical (category_id NULL ou catégorie sans vertical) - à vérifier manuellement si besoin`,
    );
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
