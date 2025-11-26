// scripts/rebuildCommissions.js
// Recalcule commission_duumini pour les commandes existantes

// ⚠️ Ajuste le chemin si besoin :
// - si ton orders.js est dans src/routes/orders.js
// - et ton db.js est dans src/lib/db.js
// alors ce require est correct.
const { getPool } = require("../src/lib/db");

// 🎯 CONFIG SIMPLE
// true = ne mettre à jour que les commandes DONE
const ONLY_DONE = false;

// true = ne mettre à jour que là où commission_duumini est NULL ou 0
const ONLY_MISSING = false;

async function main() {
  const pool = getPool();

  // Construire les conditions optionnelles pour le UPDATE
  const updateConditions = [];
  if (ONLY_DONE) {
    updateConditions.push("o.status = 'DONE'");
  }
  if (ONLY_MISSING) {
    updateConditions.push(
      "(o.commission_duumini IS NULL OR o.commission_duumini = 0)"
    );
  }
  const whereUpdate =
    updateConditions.length > 0 ? `WHERE ${updateConditions.join(" AND ")}` : "";

  console.log("🔁 Recalcul des commissions Duumini…");
  console.log(
    "   - Filtre DONE seulement :", ONLY_DONE ? "OUI" : "NON",
    "\n   - Filtre seulement NULL/0 :", ONLY_MISSING ? "OUI" : "NON"
  );

  // (Optionnel) Aperçu de quelques commissions calculées avant UPDATE
  const [preview] = await pool.query(
    `
    SELECT 
      oi.order_id,
      SUM(
        ROUND(
          p.price
          * CASE
              WHEN LOWER(COALESCE(p.sub_category, '')) = 'food' THEN 0.18
              ELSE 0.11
            END
          * oi.qty,
          2
        )
      ) AS computed_commission
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    GROUP BY oi.order_id
    ORDER BY oi.order_id DESC
    LIMIT 10
    `
  );

  console.log("👀 Aperçu des 10 dernières commissions calculées :");
  preview.forEach((row) => {
    console.log(
      `   - Order #${row.order_id} → commission = ${row.computed_commission} MAD`
    );
  });

  // 🔥 UPDATE global sur la table orders
  const [result] = await pool.query(
    `
    UPDATE orders o
    JOIN (
      SELECT
        oi.order_id,
        SUM(
          ROUND(
            p.price
            * CASE
                WHEN LOWER(COALESCE(p.sub_category, '')) = 'food' THEN 0.18
                ELSE 0.11
              END
            * oi.qty,
            2
          )
        ) AS computed_commission
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      GROUP BY oi.order_id
    ) c ON c.order_id = o.id
    SET o.commission_duumini = c.computed_commission
    ${whereUpdate}
    `
  );

  console.log("✅ Terminé.");
  console.log(`   → ${result.affectedRows} commandes mises à jour.`);

  // Si ton pool expose end(), tu peux faire :
  if (typeof pool.end === "function") {
    await pool.end();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur lors du recalcul des commissions :", err);
  process.exit(1);
});
