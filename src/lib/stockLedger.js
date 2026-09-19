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

const MISSING_TABLE_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"]);

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

/**
 * Détermine l'entrepôt à utiliser pour un produit : sa propre surcharge
 * (products.warehouse_id) en premier, sinon l'entrepôt par défaut de sa
 * boutique (shops.default_warehouse_id), sinon le premier entrepôt actif.
 * Tant qu'un seul entrepôt existe, les trois se résolvent au même endroit.
 */
async function resolveWarehouseId(runner, { warehouseId = null, shopId = null } = {}) {
  if (warehouseId) return Number(warehouseId);

  if (shopId) {
    try {
      const r = runner || getPool();
      const [[row]] = await r.query(
        `SELECT default_warehouse_id FROM shops WHERE id = ? LIMIT 1`,
        [shopId],
      );
      if (row?.default_warehouse_id) return Number(row.default_warehouse_id);
    } catch (e) {
      if (!isMissingTableError(e)) {
        console.warn("[stockLedger] resolveWarehouseId shop lookup failed:", e?.message || e);
      }
    }
  }

  return getDefaultWarehouseId(runner);
}

/**
 * Retrouve dans le ledger l'entrepôt exact d'où une vente a été
 * décomptée, pour qu'une annulation/modification restitue le stock au
 * même endroit — même si l'entrepôt par défaut du produit/boutique a
 * changé depuis la vente.
 */
async function findOrderItemWarehouseId(runner, { orderId, productId, variantId = null }) {
  try {
    const r = runner || getPool();
    const [[row]] = await r.query(
      `SELECT warehouse_id FROM stock_movements
       WHERE reference_type = 'ORDER' AND reference_id = ? AND product_id = ?
         AND (variant_id <=> ?) AND type = 'OUT_SALE'
       ORDER BY id DESC LIMIT 1`,
      [orderId, productId, variantId],
    );
    return row?.warehouse_id ? Number(row.warehouse_id) : null;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn("[stockLedger] findOrderItemWarehouseId failed:", e?.message || e);
    }
    return null;
  }
}

/**
 * Nombre de pièces par carton pour un produit (1 = pas de conditionnement
 * carton connu). Best-effort : renvoie 1 si la colonne n'est pas encore
 * migrée ou si le produit n'a pas de valeur définie.
 */
async function getProductUnitsPerCarton(runner, productId) {
  try {
    const r = runner || getPool();
    const [[row]] = await r.query(`SELECT units_per_carton FROM products WHERE id = ? LIMIT 1`, [
      productId,
    ]);
    const n = Number(row?.units_per_carton);
    return n > 0 ? n : 1;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn("[stockLedger] getProductUnitsPerCarton failed:", e?.message || e);
    }
    return 1;
  }
}

/**
 * Convertit une quantité saisie en cartons vers des pièces (unité
 * canonique du stock). `unit` absent/"PIECE" laisse la quantité inchangée.
 */
function toBaseQty(qty, unit, unitsPerCarton) {
  const n = Number(qty) || 0;
  if (String(unit).toUpperCase() === "CARTON") {
    return n * (Number(unitsPerCarton) > 0 ? Number(unitsPerCarton) : 1);
  }
  return n;
}

/**
 * CMP (coût moyen pondéré) : moyenne des coûts d'achat (stock_movements de
 * type IN_PURCHASE, unit_cost déjà ramené au prix par pièce) pondérée par
 * les quantités reçues. Recalculée sur tout l'historique à chaque nouvelle
 * réception, pas juste "le dernier prix payé" — méthode alignée sur le
 * classeur de gestion existant (colonne CMP de l'onglet Stock).
 *
 * Écrit le résultat dans products.supplier_price_ht, qui alimente déjà le
 * calcul de marge (order_items.unit_cost_snapshot, voir orders.js) et la
 * valeur du stock affichée. Best-effort comme le reste du ledger.
 */
async function recomputeAndApplyCmp(conn, productId) {
  try {
    const [[row]] = await conn.query(
      `SELECT SUM(qty * unit_cost) AS total_cost, SUM(qty) AS total_qty
       FROM stock_movements
       WHERE product_id = ? AND type = 'IN_PURCHASE' AND unit_cost IS NOT NULL`,
      [productId],
    );

    const totalQty = Number(row?.total_qty || 0);
    if (!totalQty) return null;

    const cmp = Number(row.total_cost || 0) / totalQty;
    await conn.query(`UPDATE products SET supplier_price_ht = ? WHERE id = ?`, [
      +cmp.toFixed(2),
      productId,
    ]);
    return cmp;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn("[stockLedger] recomputeAndApplyCmp failed:", e?.message || e);
    }
    return null;
  }
}

module.exports = {
  MOVEMENT_TYPES,
  getDefaultWarehouseId,
  upsertWarehouseStock,
  recordStockMovement,
  resolveWarehouseId,
  findOrderItemWarehouseId,
  getProductUnitsPerCarton,
  toBaseQty,
  recomputeAndApplyCmp,
};
