// src/scripts/reconcileWarehouseStock.js
// Usage: node src/scripts/reconcileWarehouseStock.js
//
// warehouse_stock (source de vérité par entrepôt, voir stockLedger.js)
// n'est alimenté que par les mouvements survenus DEPUIS la mise en place
// du module stock (Phase 1) : commandes, livraisons fournisseurs,
// ajustements manuels. Tout le stock existant avant cette date n'y a
// jamais été reporté, donc la page "Entrepôts & Stock" peut être
// incomplète ou désynchronisée par rapport à products.stock /
// product_variants.stock (qui restent la référence historique).
//
// Ce script aligne warehouse_stock sur products.stock/product_variants.stock
// pour chaque produit/variante, dans son entrepôt résolu (surcharge produit
// > entrepôt par défaut de la boutique > premier entrepôt actif) :
//   - Aucune ligne warehouse_stock -> création (mouvement IN_ADJUSTMENT si
//     stock > 0, sinon ligne à 0 directement).
//   - Ligne existante mais quantité différente -> mouvement d'ajustement
//     (IN_ADJUSTMENT/OUT_ADJUSTMENT) pour combler l'écart, tracé dans le
//     ledger comme tout le reste.
//   - Déjà cohérent -> rien à faire.
//
// Idempotent : relancer ce script quand tout est déjà aligné ne crée aucun
// mouvement (écart nul partout). N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { resolveWarehouseId, recordStockMovement } = require("../lib/stockLedger");

async function reconcileOne(conn, { warehouseId, productId, variantId, targetQty, note }) {
  const [[row]] = await conn.query(
    `SELECT id, quantity FROM warehouse_stock
     WHERE warehouse_id = ? AND product_id = ? AND (variant_id <=> ?)
     LIMIT 1`,
    [warehouseId, productId, variantId],
  );

  if (!row) {
    if (targetQty > 0) {
      await recordStockMovement(conn, {
        warehouseId,
        productId,
        variantId,
        type: "IN_ADJUSTMENT",
        qty: targetQty,
        referenceType: "MANUAL",
        note,
      });
    } else {
      await conn.query(
        `INSERT INTO warehouse_stock (warehouse_id, product_id, variant_id, quantity) VALUES (?, ?, ?, 0)`,
        [warehouseId, productId, variantId],
      );
    }
    return "created";
  }

  const delta = targetQty - Number(row.quantity || 0);
  if (delta === 0) return "unchanged";

  await recordStockMovement(conn, {
    warehouseId,
    productId,
    variantId,
    type: delta > 0 ? "IN_ADJUSTMENT" : "OUT_ADJUSTMENT",
    qty: Math.abs(delta),
    referenceType: "MANUAL",
    note,
  });
  return "adjusted";
}

async function main() {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const stats = { products: { created: 0, adjusted: 0, unchanged: 0 }, variants: { created: 0, adjusted: 0, unchanged: 0 } };

    const [products] = await conn.query(
      `SELECT id, shop_id, warehouse_id, stock FROM products`,
    );

    for (const p of products) {
      const warehouseId = await resolveWarehouseId(conn, { warehouseId: p.warehouse_id, shopId: p.shop_id });
      if (!warehouseId) continue;

      const result = await reconcileOne(conn, {
        warehouseId,
        productId: p.id,
        variantId: null,
        targetQty: Number(p.stock || 0),
        note: "Réconciliation stock initial (migration reconcileWarehouseStock)",
      });
      stats.products[result]++;
    }

    const [variants] = await conn.query(
      `SELECT pv.id, pv.stock, p.id AS product_id, p.shop_id, p.warehouse_id
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id`,
    );

    for (const v of variants) {
      const warehouseId = await resolveWarehouseId(conn, { warehouseId: v.warehouse_id, shopId: v.shop_id });
      if (!warehouseId) continue;

      const result = await reconcileOne(conn, {
        warehouseId,
        productId: v.product_id,
        variantId: v.id,
        targetQty: Number(v.stock || 0),
        note: "Réconciliation stock initial variante (migration reconcileWarehouseStock)",
      });
      stats.variants[result]++;
    }

    console.log(
      `[reconcileWarehouseStock] produits — créés: ${stats.products.created}, ajustés: ${stats.products.adjusted}, déjà cohérents: ${stats.products.unchanged}`,
    );
    console.log(
      `[reconcileWarehouseStock] variantes — créées: ${stats.variants.created}, ajustées: ${stats.variants.adjusted}, déjà cohérentes: ${stats.variants.unchanged}`,
    );
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[reconcileWarehouseStock] FAILED:", e.message || e);
  process.exit(1);
});
