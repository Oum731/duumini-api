// src/scripts/recomputeAllCmp.js
// Usage: node src/scripts/recomputeAllCmp.js
//
// Passe du prix d'achat "dernière livraison reçue" au vrai CMP (coût moyen
// pondéré, voir stockLedger.recomputeAndApplyCmp) pour tous les produits
// ayant déjà un historique de réceptions — sans attendre leur prochaine
// livraison. Idempotent : relancer ce script ne change rien si aucune
// nouvelle réception n'a eu lieu entretemps.
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { recomputeAndApplyCmp } = require("../lib/stockLedger");

async function main() {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [rows] = await conn.query(
      `SELECT DISTINCT product_id FROM stock_movements
       WHERE type = 'IN_PURCHASE' AND unit_cost IS NOT NULL AND product_id IS NOT NULL`,
    );

    let updated = 0;
    for (const { product_id } of rows) {
      const cmp = await recomputeAndApplyCmp(conn, product_id);
      if (cmp != null) updated++;
    }

    console.log(`[recomputeAllCmp] ${updated}/${rows.length} produit(s) mis à jour avec leur CMP.`);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[recomputeAllCmp] FAILED:", e.message || e);
  process.exit(1);
});
