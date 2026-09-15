// src/lib/stockLedger.js
//
// Source de vérité du stock par entrepôt + journal de mouvements (ledger).
// Objectif : ne plus jamais faire un simple `UPDATE products SET stock=...`
// sans laisser de trace exploitable (qui, quand, pourquoi, à partir de quelle
// commande/livraison). Conçu pour plusieurs entrepôts dès le départ, même si
// un seul existe aujourd'hui (Sidi Moumen).
//
// Tout est best-effort et n'interrompt jamais le flux appelant (commande,
// annulation...) : si les tables warehouse_stock/stock_movements n'existent
// pas encore (migration pas encore jouée), on log un warning et on continue
// silencieusement plutôt que de faire échouer une commande.
const { getPool } = require("./db");

const MOVEMENT_TYPES = [
  "IN_PURCHASE",
  "IN_RETURN_CANCEL",
  "IN_ADJUSTMENT",
  "OUT_SALE",
  "OUT_ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
];

const OUTBOUND_TYPES = new Set(["OUT_SALE", "OUT_ADJUSTMENT", "TRANSFER_OUT"]);

const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE"]);

let cachedDefaultWarehouseId = null;

function isMissingTableError(e) {
  return !!e && MISSING_TABLE_CODES.has(e.code);
}

/**
 * Retourne l'id du premier entrepôt actif (aujourd'hui : Sidi Moumen).
 * Mis en cache en mémoire process (rarement modifié).
 */
async function getDefaultWarehouseId(runner) {
  if (cachedDefaultWarehouseId) return cachedDefaultWarehouseId;

  try {
    const r = runner || getPool();
    const [[row]] = await r.query(
      `SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id ASC LIMIT 1`,
    );
    cachedDefaultWarehouseId = row?.id ? Number(row.id) : null;
    return cachedDefaultWarehouseId;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn("[stockLedger] getDefaultWarehouseId failed:", e?.message || e);
    }
    return null;
  }
}

/**
 * Ajuste warehouse_stock de deltaQty (peut être négatif) pour un produit
 * (ou une variante) dans un entrepôt donné. Doit être appelé à l'intérieur
 * d'une transaction (conn) pour rester cohérent avec le ledger.
 */
async function upsertWarehouseStock(conn, { warehouseId, productId, variantId = null, deltaQty }) {
  const [[existing]] = await conn.query(
    `SELECT id, quantity FROM warehouse_stock
     WHERE warehouse_id = ? AND product_id = ? AND (variant_id <=> ?)
     LIMIT 1 FOR UPDATE`,
    [warehouseId, productId, variantId],
  );

  if (existing) {
    const newQty = Math.max(0, Number(existing.quantity || 0) + Number(deltaQty || 0));
    await conn.query(`UPDATE warehouse_stock SET quantity = ? WHERE id = ?`, [
      newQty,
      existing.id,
    ]);
    return newQty;
  }

  const newQty = Math.max(0, Number(deltaQty || 0));
  await conn.query(
    `INSERT INTO warehouse_stock (warehouse_id, product_id, variant_id, quantity)
     VALUES (?, ?, ?, ?)`,
    [warehouseId, productId, variantId, newQty],
  );
  return newQty;
}

/**
 * Enregistre un mouvement de stock (ligne du ledger) + répercute la
 * quantité sur warehouse_stock. `conn` doit être la connexion de la
 * transaction en cours (mêmes garanties atomiques que le reste de l'écriture
 * commande/stock).
 *
 * qty est toujours positif en entrée ; le sens (+/-) est déduit de `type`.
 */
async function recordStockMovement(
  conn,
  {
    warehouseId = null,
    productId,
    variantId = null,
    type,
    qty,
    unitCost = null,
    referenceType = "MANUAL",
    referenceId = null,
    performedBy = null,
    note = null,
  },
) {
  if (!MOVEMENT_TYPES.includes(type)) {
    console.warn("[stockLedger] unknown movement type:", type);
    return null;
  }

  const cleanQty = Math.abs(Number(qty || 0));
  if (!cleanQty) return null;

  try {
    const wid = warehouseId || (await getDefaultWarehouseId(conn));
    if (!wid) {
      console.warn("[stockLedger] no active warehouse found, movement skipped");
      return null;
    }

    await conn.query(
      `INSERT INTO stock_movements
        (warehouse_id, product_id, variant_id, type, qty, unit_cost,
         reference_type, reference_id, performed_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wid,
        productId || null,
        variantId || null,
        type,
        cleanQty,
        unitCost != null ? Number(unitCost) : null,
        referenceType,
        referenceId || null,
        performedBy || null,
        note || null,
      ],
    );

    const signedQty = OUTBOUND_TYPES.has(type) ? -cleanQty : cleanQty;

    await upsertWarehouseStock(conn, {
      warehouseId: wid,
      productId,
      variantId,
      deltaQty: signedQty,
    });

    return wid;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn("[stockLedger] recordStockMovement failed:", e?.message || e);
    }
    return null;
  }
}

module.exports = {
  MOVEMENT_TYPES,
  getDefaultWarehouseId,
  upsertWarehouseStock,
  recordStockMovement,
};
