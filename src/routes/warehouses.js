// src/routes/warehouses.js
//
// Module Stock & Entrepôts. Un seul entrepôt existe aujourd'hui (Sidi
// Moumen, voir src/scripts/createWarehousesTables.js) mais tout est écrit
// pour en supporter plusieurs : chaque route qui touche à un entrepôt précis
// est accessible à l'ADMIN (tous les entrepôts) et au gestionnaire que
// l'admin lui a affecté (un seul entrepôt, ou plusieurs).
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { recordStockMovement, getProductUnitsPerCarton } = require("../lib/stockLedger");

const router = Router();

function toPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
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

/**
 * Autorise ADMIN, ou l'utilisateur affecté comme gestionnaire de
 * l'entrepôt :id. Attache req.warehouseId (validé) pour les handlers.
 */
async function requireWarehouseAccess(req, res, next) {
  const warehouseId = toPosInt(req.params.id);
  if (!warehouseId) return res.status(400).json({ error: "Invalid warehouse id" });

  if (isAdmin(req.user)) {
    req.warehouseId = warehouseId;
    return next();
  }

  try {
    const ok = await isWarehouseManager(getPool(), warehouseId, req.user.id);
    if (!ok) {
      return res.status(403).json({ error: "Forbidden: not a manager of this warehouse" });
    }
    req.warehouseId = warehouseId;
    return next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* =========================
 * GET /api/warehouses
 * Admin: tous les entrepôts. Gestionnaire: uniquement les siens.
 * ======================= */
router.get("/", authRequired, async (req, res) => {
  try {
    const pool = getPool();

    if (isAdmin(req.user)) {
      const [rows] = await pool.query(
        `SELECT id, name, code, address, city, country_code, is_active, created_at, updated_at
         FROM warehouses
         ORDER BY id ASC`,
      );
      return res.json({ items: rows || [] });
    }

    const [rows] = await pool.query(
      `SELECT w.id, w.name, w.code, w.address, w.city, w.country_code, w.is_active,
              w.created_at, w.updated_at
       FROM warehouses w
       INNER JOIN warehouse_managers wm
         ON wm.warehouse_id = w.id AND wm.user_id = ? AND wm.is_active = 1
       ORDER BY w.id ASC`,
      [req.user.id],
    );
    return res.json({ items: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/warehouses (ADMIN)
 * ======================= */
router.post("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const name = String(req.body?.name || "").trim();
  const code = String(req.body?.code || "").trim().toUpperCase();
  const address = req.body?.address ? String(req.body.address).trim() : null;
  const city = req.body?.city ? String(req.body.city).trim() : null;
  const country_code = req.body?.country_code ? String(req.body.country_code).trim().toUpperCase() : "MA";

  if (!name || !code) {
    return res.status(400).json({ error: "name and code are required" });
  }

  try {
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO warehouses (name, code, address, city, country_code, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [name, code, address, city, country_code],
    );
    return res.status(201).json({ id: r.insertId, name, code, address, city, country_code, is_active: 1 });
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A warehouse with this code already exists" });
    }
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * PATCH /api/warehouses/:id (ADMIN)
 * ======================= */
router.patch("/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const fields = ["name", "address", "city", "country_code", "is_active"];
  const sets = [];
  const vals = [];

  for (const f of fields) {
    if (req.body?.[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(f === "is_active" ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }

  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  try {
    vals.push(id);
    await getPool().query(`UPDATE warehouses SET ${sets.join(", ")} WHERE id = ?`, vals);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * GET /api/warehouses/:id/stock
 * ======================= */
router.get("/:id/stock", authRequired, requireWarehouseAccess, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const q = String(req.query.q || "").trim();
  const lowOnly = String(req.query.lowOnly || "") === "1";

  try {
    const pool = getPool();
    const where = ["ws.warehouse_id = ?"];
    const params = [req.warehouseId];

    if (q) {
      where.push("p.name LIKE ?");
      params.push(`%${q}%`);
    }

    if (lowOnly) {
      where.push("ws.quantity <= ws.min_threshold");
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM warehouse_stock ws
       INNER JOIN products p ON p.id = ws.product_id
       WHERE ${where.join(" AND ")}`,
      params,
    );

    // Indépendant de q/lowOnly/pagination : le vrai total sous le seuil
    // d'alerte pour tout l'entrepôt, pour un KPI exact même filtré/paginé.
    const [[{ lowCount }]] = await pool.query(
      `SELECT COUNT(*) AS lowCount
       FROM warehouse_stock ws
       WHERE ws.warehouse_id = ? AND ws.quantity <= ws.min_threshold`,
      [req.warehouseId],
    );

    const [rows] = await pool.query(
      `SELECT ws.id, ws.warehouse_id, ws.product_id, ws.variant_id, ws.quantity,
              ws.min_threshold, ws.updated_at,
              p.name AS product_name, p.brand AS product_brand,
              v.size AS variant_size, v.color AS variant_color, v.sku AS variant_sku
       FROM warehouse_stock ws
       INNER JOIN products p ON p.id = ws.product_id
       LEFT JOIN product_variants v ON v.id = ws.variant_id
       WHERE ${where.join(" AND ")}
       ORDER BY p.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return res.json({
      items: rows || [],
      pageInfo: buildPageInfo(total, page, pageSize),
      low_count: Number(lowCount || 0),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/warehouses/:id/stock/adjust
 * Correction manuelle (inventaire, casse, erreur...). Toujours tracée dans
 * stock_movements — jamais un UPDATE silencieux.
 * ======================= */
router.post("/:id/stock/adjust", authRequired, requireWarehouseAccess, async (req, res) => {
  const productId = toPosInt(req.body?.product_id);
  const variantId = req.body?.variant_id ? toPosInt(req.body.variant_id) : null;
  const rawDeltaQty = Number(req.body?.delta_qty);
  const unit = String(req.body?.unit || "PIECE").toUpperCase() === "CARTON" ? "CARTON" : "PIECE";
  const reason = req.body?.reason ? String(req.body.reason).trim() : "";

  if (!productId) return res.status(400).json({ error: "product_id is required" });
  if (!Number.isFinite(rawDeltaQty) || rawDeltaQty === 0) {
    return res.status(400).json({ error: "delta_qty must be a non-zero number" });
  }
  if (!reason) return res.status(400).json({ error: "reason is required" });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Une saisie en cartons est convertie en pièces (unité canonique du
    // stock) via products.units_per_carton ; en pièces, aucune conversion.
    let deltaQty = rawDeltaQty;
    let noteSuffix = "";
    if (unit === "CARTON") {
      const unitsPerCarton = await getProductUnitsPerCarton(conn, productId);
      deltaQty = rawDeltaQty * unitsPerCarton;
      noteSuffix = ` (${Math.abs(rawDeltaQty)} carton(s) × ${unitsPerCarton})`;
    }

    const wid = await recordStockMovement(conn, {
      warehouseId: req.warehouseId,
      productId,
      variantId,
      type: deltaQty > 0 ? "IN_ADJUSTMENT" : "OUT_ADJUSTMENT",
      qty: Math.abs(deltaQty),
      referenceType: "MANUAL",
      performedBy: req.user.id,
      note: reason + noteSuffix,
    });

    if (!wid) {
      await conn.rollback();
      return res.status(500).json({
        error:
          "Impossible d'enregistrer le mouvement : la migration warehouses n'a peut-être pas encore été jouée (node src/scripts/createWarehousesTables.js).",
      });
    }

    // Miroir sur products/product_variants pour rester compatible avec le
    // reste du code qui lit encore ces colonnes directement.
    if (variantId) {
      await conn.query(
        `UPDATE product_variants SET stock = GREATEST(0, COALESCE(stock,0) + ?) WHERE id = ?`,
        [deltaQty, variantId],
      );
    } else {
      await conn.query(
        `UPDATE products SET stock = GREATEST(0, COALESCE(stock,0) + ?) WHERE id = ?`,
        [deltaQty, productId],
      );
    }

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * GET /api/warehouses/:id/movements
 * ======================= */
router.get("/:id/movements", authRequired, requireWarehouseAccess, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const productId = req.query.product_id ? toPosInt(req.query.product_id) : null;
  const type = req.query.type ? String(req.query.type).trim().toUpperCase() : null;

  try {
    const pool = getPool();
    const where = ["sm.warehouse_id = ?"];
    const params = [req.warehouseId];

    if (productId) {
      where.push("sm.product_id = ?");
      params.push(productId);
    }
    if (type) {
      where.push("sm.type = ?");
      params.push(type);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM stock_movements sm WHERE ${where.join(" AND ")}`,
      params,
    );

    const [rows] = await pool.query(
      `SELECT sm.id, sm.warehouse_id, sm.product_id, sm.variant_id, sm.type, sm.qty,
              sm.unit_cost, sm.reference_type, sm.reference_id, sm.performed_by, sm.note,
              sm.created_at,
              p.name AS product_name,
              u.first_name AS performed_by_first_name, u.last_name AS performed_by_last_name
       FROM stock_movements sm
       LEFT JOIN products p ON p.id = sm.product_id
       LEFT JOIN users u ON u.id = sm.performed_by
       WHERE ${where.join(" AND ")}
       ORDER BY sm.created_at DESC, sm.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return res.json({ items: rows || [], pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Gestionnaires d'entrepôt (ADMIN affecte)
 * ======================= */
router.get("/:id/managers", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const [rows] = await getPool().query(
      `SELECT wm.id, wm.user_id, wm.is_active, wm.created_at,
              u.first_name, u.last_name, u.phone, u.role
       FROM warehouse_managers wm
       INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.warehouse_id = ?
       ORDER BY wm.created_at DESC`,
      [id],
    );
    return res.json({ items: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/:id/managers", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  const userId = toPosInt(req.body?.user_id);
  if (!id) return res.status(400).json({ error: "Invalid warehouse id" });
  if (!userId) return res.status(400).json({ error: "user_id is required" });

  try {
    await getPool().query(
      `INSERT INTO warehouse_managers (warehouse_id, user_id, assigned_by, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1, assigned_by = VALUES(assigned_by)`,
      [id, userId, req.user.id],
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.delete("/:id/managers/:userId", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  const userId = toPosInt(req.params.userId);
  if (!id || !userId) return res.status(400).json({ error: "Invalid id" });

  try {
    await getPool().query(
      `UPDATE warehouse_managers SET is_active = 0 WHERE warehouse_id = ? AND user_id = ?`,
      [id, userId],
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
