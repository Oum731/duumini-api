// src/routes/supplierDeliveries.js
//
// Traçabilité fournisseurs : enregistre une réception de marchandise en
// entrepôt (livraison fournisseur) avec ses lignes, et alimente le ledger
// de stock (stock_movements, type IN_PURCHASE) pour que chaque unité en
// stock soit traçable jusqu'au fournisseur et au prix d'achat exacts.
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin, isSupplier } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { recordStockMovement, getProductUnitsPerCarton } = require("../lib/stockLedger");

const router = Router();

function toPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// ✅ unit/base_qty (voir src/scripts/addSupplierDeliveryItemUnit.js) —
// détection paresseuse + cache, même esprit que le reste de l'API.
let _deliveryItemsHasUnitCache = null;

async function deliveryItemsHasUnit(pool) {
  if (_deliveryItemsHasUnitCache != null) return _deliveryItemsHasUnitCache;
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'supplier_delivery_items'
        AND COLUMN_NAME = 'unit'`,
  );
  _deliveryItemsHasUnitCache = rows.length > 0;
  return _deliveryItemsHasUnitCache;
}

async function resolveOwnSupplierShopId(pool, userId) {
  const [[row]] = await pool.query(
    `SELECT id FROM shops WHERE owner_id = ? ORDER BY id ASC LIMIT 1`,
    [userId],
  );
  return row?.id ? Number(row.id) : null;
}

async function isWarehouseManager(pool, warehouseId, userId) {
  const [[row]] = await pool.query(
    `SELECT id FROM warehouse_managers
     WHERE warehouse_id = ? AND user_id = ? AND is_active = 1
     LIMIT 1`,
    [warehouseId, userId],
  );
  return !!row;
}

/* =========================
 * GET /api/supplier-deliveries
 * Admin: tout, filtrable. Fournisseur: ses livraisons seulement.
 * Gestionnaire d'entrepôt: livraisons de son/ses entrepôt(s) seulement.
 * ======================= */
router.get("/", authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  try {
    const where = ["1=1"];
    const params = [];

    if (isAdmin(req.user)) {
      const supplierShopId = req.query.supplier_shop_id ? toPosInt(req.query.supplier_shop_id) : null;
      const warehouseId = req.query.warehouse_id ? toPosInt(req.query.warehouse_id) : null;
      if (supplierShopId) {
        where.push("sd.supplier_shop_id = ?");
        params.push(supplierShopId);
      }
      if (warehouseId) {
        where.push("sd.warehouse_id = ?");
        params.push(warehouseId);
      }
    } else if (isSupplier(req.user)) {
      const myShopId = await resolveOwnSupplierShopId(pool, req.user.id);
      if (!myShopId) return res.status(403).json({ error: "No supplier shop linked to this user" });
      where.push("sd.supplier_shop_id = ?");
      params.push(myShopId);
    } else {
      const [mine] = await pool.query(
        `SELECT warehouse_id FROM warehouse_managers WHERE user_id = ? AND is_active = 1`,
        [req.user.id],
      );
      const ids = (mine || []).map((r) => Number(r.warehouse_id));
      if (!ids.length) return res.status(403).json({ error: "Forbidden" });
      where.push(`sd.warehouse_id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM supplier_deliveries sd WHERE ${whereSql}`,
      params,
    );

    const [rows] = await pool.query(
      `
      SELECT sd.id, sd.supplier_shop_id, sd.warehouse_id, sd.reference, sd.status,
             sd.received_by, sd.note, sd.created_at,
             s.name AS supplier_name,
             w.name AS warehouse_name,
             u.first_name AS received_by_first_name, u.last_name AS received_by_last_name,
             (SELECT COALESCE(SUM(qty), 0) FROM supplier_delivery_items sdi WHERE sdi.delivery_id = sd.id) AS total_qty,
             (SELECT COALESCE(SUM(qty * unit_cost), 0) FROM supplier_delivery_items sdi WHERE sdi.delivery_id = sd.id) AS total_cost
      FROM supplier_deliveries sd
      LEFT JOIN shops s ON s.id = sd.supplier_shop_id
      LEFT JOIN warehouses w ON w.id = sd.warehouse_id
      LEFT JOIN users u ON u.id = sd.received_by
      WHERE ${whereSql}
      ORDER BY sd.created_at DESC, sd.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    return res.json({ items: rows || [], pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * GET /api/supplier-deliveries/:id
 * ======================= */
router.get("/:id", authRequired, async (req, res) => {
  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const pool = getPool();

  try {
    const [[delivery]] = await pool.query(
      `
      SELECT sd.*, s.name AS supplier_name, w.name AS warehouse_name
      FROM supplier_deliveries sd
      LEFT JOIN shops s ON s.id = sd.supplier_shop_id
      LEFT JOIN warehouses w ON w.id = sd.warehouse_id
      WHERE sd.id = ?
      LIMIT 1
      `,
      [id],
    );

    if (!delivery) return res.status(404).json({ error: "Not found" });

    if (!isAdmin(req.user)) {
      if (isSupplier(req.user)) {
        const myShopId = await resolveOwnSupplierShopId(pool, req.user.id);
        if (!myShopId || Number(myShopId) !== Number(delivery.supplier_shop_id)) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        const ok = await isWarehouseManager(pool, delivery.warehouse_id, req.user.id);
        if (!ok) return res.status(403).json({ error: "Forbidden" });
      }
    }

    const hasUnitCol = await deliveryItemsHasUnit(pool);
    const [items] = await pool.query(
      `
      SELECT sdi.id, sdi.product_id, sdi.variant_id, sdi.qty, sdi.unit_cost
             ${hasUnitCol ? ", sdi.unit, sdi.base_qty" : ", 'PIECE' AS unit, sdi.qty AS base_qty"},
             p.name AS product_name,
             v.size AS variant_size, v.color AS variant_color, v.sku AS variant_sku
      FROM supplier_delivery_items sdi
      LEFT JOIN products p ON p.id = sdi.product_id
      LEFT JOIN product_variants v ON v.id = sdi.variant_id
      WHERE sdi.delivery_id = ?
      ORDER BY sdi.id ASC
      `,
      [id],
    );

    return res.json({ ...delivery, items: items || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/supplier-deliveries
 * Body: { supplier_shop_id (admin only, sinon déduit), warehouse_id,
 *         reference?, note?,
 *         items: [{ product_id, variant_id?, qty, unit_cost, unit? }] }
 * unit: "PIECE" (défaut) ou "CARTON" — qty/unit_cost restent tels que
 * saisis (fidèles au bon de livraison), convertis en pièces en interne
 * via products.units_per_carton pour le stock/ledger/marge.
 * Visible: ADMIN, FOURNISSEUR (sa propre boutique), gestionnaire d'entrepôt
 * ======================= */
router.post("/", authRequired, async (req, res) => {
  const pool = getPool();

  const warehouseId = toPosInt(req.body?.warehouse_id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const reference = req.body?.reference ? String(req.body.reference).trim() : null;
  const note = req.body?.note ? String(req.body.note).trim() : null;

  if (!warehouseId) return res.status(400).json({ error: "warehouse_id is required" });
  if (!items.length) return res.status(400).json({ error: "At least one item is required" });

  let supplierShopId = req.body?.supplier_shop_id ? toPosInt(req.body.supplier_shop_id) : null;

  try {
    if (isSupplier(req.user) && !isAdmin(req.user)) {
      supplierShopId = await resolveOwnSupplierShopId(pool, req.user.id);
      if (!supplierShopId) return res.status(403).json({ error: "No supplier shop linked to this user" });
    } else if (!isAdmin(req.user)) {
      const ok = await isWarehouseManager(pool, warehouseId, req.user.id);
      if (!ok) return res.status(403).json({ error: "Forbidden: not a manager of this warehouse" });
      if (!supplierShopId) return res.status(400).json({ error: "supplier_shop_id is required" });
    } else if (!supplierShopId) {
      return res.status(400).json({ error: "supplier_shop_id is required" });
    }

    const cleanItems = [];
    for (const it of items) {
      const productId = toPosInt(it?.product_id);
      const variantId = it?.variant_id ? toPosInt(it.variant_id) : null;
      const qty = Number(it?.qty);
      const unitCost = Number(it?.unit_cost);
      const unit = String(it?.unit || "PIECE").toUpperCase() === "CARTON" ? "CARTON" : "PIECE";

      if (!productId || !Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: "Each item needs a valid product_id and qty" });
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        return res.status(400).json({ error: "Each item needs a valid unit_cost" });
      }

      cleanItems.push({ productId, variantId, qty: Math.trunc(qty), unitCost, unit });
    }

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const hasUnitCol = await deliveryItemsHasUnit(pool);

      const [r] = await conn.query(
        `INSERT INTO supplier_deliveries
          (supplier_shop_id, warehouse_id, reference, status, received_by, note)
         VALUES (?, ?, ?, 'RECEIVED', ?, ?)`,
        [supplierShopId, warehouseId, reference, req.user.id, note],
      );

      const deliveryId = r.insertId;

      for (const it of cleanItems) {
        // Le carton reste l'unité de facturation (qty/unit_cost saisis
        // fidèles au bon de livraison), mais le stock/ledger/marge
        // travaillent toujours en pièces (unité canonique, voir
        // stockLedger.js) — d'où la conversion via units_per_carton.
        const unitsPerCarton = it.unit === "CARTON" ? await getProductUnitsPerCarton(conn, it.productId) : 1;
        const baseQty = it.qty * unitsPerCarton;
        const baseUnitCost = it.unitCost / unitsPerCarton;

        if (hasUnitCol) {
          await conn.query(
            `INSERT INTO supplier_delivery_items (delivery_id, product_id, variant_id, qty, unit, base_qty, unit_cost)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [deliveryId, it.productId, it.variantId, it.qty, it.unit, baseQty, it.unitCost],
          );
        } else {
          await conn.query(
            `INSERT INTO supplier_delivery_items (delivery_id, product_id, variant_id, qty, unit_cost)
             VALUES (?, ?, ?, ?, ?)`,
            [deliveryId, it.productId, it.variantId, baseQty, it.unitCost],
          );
        }

        await recordStockMovement(conn, {
          warehouseId,
          productId: it.productId,
          variantId: it.variantId,
          type: "IN_PURCHASE",
          qty: baseQty,
          unitCost: baseUnitCost,
          referenceType: "SUPPLIER_DELIVERY",
          referenceId: deliveryId,
          performedBy: req.user.id,
          note: reference ? `Livraison ${reference}` : null,
        });

        // Miroir products/product_variants — même logique que
        // l'ajustement manuel (src/routes/warehouses.js).
        if (it.variantId) {
          await conn.query(
            `UPDATE product_variants SET stock = COALESCE(stock,0) + ? WHERE id = ?`,
            [baseQty, it.variantId],
          );
        } else {
          await conn.query(
            `UPDATE products SET stock = COALESCE(stock,0) + ? WHERE id = ?`,
            [baseQty, it.productId],
          );
        }

        // Prix d'achat = dernière livraison reçue (utilisé pour la marge,
        // voir src/lib/pricing.js) — toujours ramené au prix par pièce
        // pour rester cohérent avec order_items.unit_cost_snapshot.
        await conn.query(`UPDATE products SET supplier_price_ht = ? WHERE id = ?`, [
          +baseUnitCost.toFixed(2),
          it.productId,
        ]);
      }

      await conn.commit();
      return res.status(201).json({ id: deliveryId, ok: true });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      return res.status(500).json({ error: e.message });
    } finally {
      conn.release();
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
