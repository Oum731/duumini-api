// scripts/recomputeStock.js
const path = require('path');

// Optionnel mais pratique si tu utilises .env à la racine
try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
  });
} catch (e) {
  console.log('[recomputeStock] .env non chargé (pas bloquant si déjà géré ailleurs)');
}

// 🔹 ICI on corrige le chemin :
const { getPool } = require('../src/lib/db');

async function main() {
  const pool = getPool();
  console.log('Recalcul des stocks à partir des commandes existantes...');

  const [rows] = await pool.query(`
    SELECT 
      oi.product_id,
      SUM(oi.qty) AS ordered_qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('OPEN','PREPARATION','DELIVERY','DONE')
    GROUP BY oi.product_id
  `);

  for (const r of rows) {
    const productId = r.product_id;
    const ordered = Number(r.ordered_qty || 0);

    const [[p]] = await pool.query(
      `SELECT stock FROM products WHERE id = ?`,
      [productId]
    );
    if (!p || p.stock === null || p.stock === undefined) {
      // stock illimité ou non renseigné → on ne touche pas
      continue;
    }

    const current = Number(p.stock || 0);
    const next = Math.max(0, current - ordered);

    await pool.query(
      `UPDATE products SET stock = ? WHERE id = ?`,
      [next, productId]
    );
    console.log(`Produit #${productId} : ${current} -> ${next} (commandé: ${ordered})`);
  }

  console.log('✅ Recalcul des stocks terminé.');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Erreur dans recomputeStock:', e);
  process.exit(1);
});
