// src/routes/supplier_products.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function trimOrNull(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/**
 * GET /api/supplier-products
 * Visible: VENDEUR, ADMIN, FOURNISSEUR
 * Query:
 *  - supplier_shop_id? (filtre)
 *  - q? (recherche title)
 *  - onlyActive? (1/0)
 *  - page/pageSize
 *
 * Règles:
 *  - FOURNISSEUR: ne voit que ses produits (via supplier_shop_id = shopId du fournisseur)
 *    -> on prend supplier_shop_id depuis req.user.supplier_shop_id si tu l’ajoutes au token,
 *       sinon il devra passer supplier_shop_id côté UI (ou on peut déduire via shops.owner_id = req.user.id)
 */
router.get("/", authRequired, requireRole("VENDEUR", "ADMIN", "FOURNISSEUR"), async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const q = String(req.query.q || "").trim().toLowerCase();
  const onlyActive = req.query.onlyActive == null ? 1 : (String(req.query.onlyActive) === "0" ? 0 : 1);

  let supplier_shop_id = req.query.supplier_shop_id != null ? Number(req.query.supplier_shop_id) : null;

  try {
    // Si FOURNISSEUR: on force supplier_shop_id = shop du user (owner_id)
    if (!isAdmin(req.user) && String(req.user.role || "").toUpperCase() === "FOURNISSEUR") {
      const [shops] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [req.user.id]
      );
      const myShop = shops && shops[0];
      if (!myShop) return res.status(403).json({ error: "No supplier shop linked to this user" });
      supplier_shop_id = Number(myShop.id);
    }

    const where = ["1=1"];
    const params = [];

    if (supplier_shop_id != null) {
      if (!Number.isFinite(supplier_shop_id) || supplier_shop_id <= 0) return res.status(400).json({ error: "supplier_shop_id invalid" });
      where.push("sp.supplier_shop_id=?");
      params.push(supplier_shop_id);
    }

    if (q) {
      where.push("(LOWER(sp.title) LIKE ? OR LOWER(COALESCE(sp.slug,'')) LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }

    if (onlyActive === 1) {
      where.push("sp.is_active=1");
    }

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM supplier_products sp WHERE ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `
      SELECT sp.*, s.name AS supplier_name, s.city AS supplier_city
      FROM supplier_products sp
      LEFT JOIN shops s ON s.id = sp.supplier_shop_id
      WHERE ${whereSql}
      ORDER BY sp.updated_at DESC, sp.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/supplier-products
 * Visible: FOURNISSEUR, ADMIN
 * Body:
 *  - supplier_shop_id (ADMIN only) sinon auto via shops.owner_id
 *  - title, slug?, description?, unit?, stock_qty?, price_wholesale?, is_active?
 */
router.post("/", authRequired, requireRole("ADMIN", "FOURNISSEUR"), async (req, res) => {
  const pool = getPool();

  try {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "title required" });

    let supplier_shop_id = req.body?.supplier_shop_id != null ? Number(req.body.supplier_shop_id) : null;

    if (!isAdmin(req.user)) {
      // fournisseur: on déduit son shop via owner_id
      const [shops] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [req.user.id]
      );
      const myShop = shops && shops[0];
      if (!myShop) return res.status(403).json({ error: "No supplier shop linked to this user" });
      supplier_shop_id = Number(myShop.id);
    } else {
      if (!Number.isFinite(supplier_shop_id) || supplier_shop_id <= 0) {
        return res.status(400).json({ error: "supplier_shop_id required (admin)" });
      }
    }

    const slug = trimOrNull(req.body?.slug);
    const description = trimOrNull(req.body?.description);
    const unit = trimOrNull(req.body?.unit);
    const stock_qty = toNum(req.body?.stock_qty, 0);
    const price_wholesale = toNum(req.body?.price_wholesale, 0);
    const is_active = req.body?.is_active == null ? 1 : (req.body.is_active ? 1 : 0);

    const [r] = await pool.query(
      `
      INSERT INTO supplier_products
        (supplier_shop_id, title, slug, description, unit, stock_qty, price_wholesale, is_active)
      VALUES (?,?,?,?,?,?,?,?)
      `,
      [supplier_shop_id, title, slug, description, unit, stock_qty, price_wholesale, is_active]
    );

    const [rows] = await pool.query("SELECT * FROM supplier_products WHERE id=?", [r.insertId]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/supplier-products/:id
 * Visible: FOURNISSEUR (son shop), ADMIN
 */
router.put("/:id", authRequired, requireRole("ADMIN", "FOURNISSEUR"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();

  try {
    const [[existing]] = await pool.query("SELECT * FROM supplier_products WHERE id=? LIMIT 1", [id]);
    if (!existing) return res.status(404).json({ error: "Not found" });

    if (!isAdmin(req.user)) {
      const [shops] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [req.user.id]
      );
      const myShop = shops && shops[0];
      if (!myShop) return res.status(403).json({ error: "No supplier shop linked to this user" });
      if (Number(existing.supplier_shop_id) !== Number(myShop.id)) return res.status(403).json({ error: "Forbidden" });
    }

    const patch = {};
    const allowed = ["title", "slug", "description", "unit", "stock_qty", "price_wholesale", "is_active"];
    for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];

    const keys = Object.keys(patch);
    if (!keys.length) return res.json({ ok: true });

    const set = [];
    const params = [];
    for (const k of keys) {
      if (k === "title") {
        const v = String(patch[k] || "").trim();
        if (!v) return res.status(400).json({ error: "title invalid" });
        set.push("title=?"); params.push(v);
      } else if (k === "slug" || k === "description" || k === "unit") {
        set.push(`${k}=?`); params.push(trimOrNull(patch[k]));
      } else if (k === "stock_qty" || k === "price_wholesale") {
        const v = toNum(patch[k], 0);
        set.push(`${k}=?`); params.push(v);
      } else if (k === "is_active") {
        set.push("is_active=?"); params.push(patch[k] ? 1 : 0);
      }
    }

    params.push(id);
    await pool.query(`UPDATE supplier_products SET ${set.join(", ")} WHERE id=?`, params);

    const [rows] = await pool.query("SELECT * FROM supplier_products WHERE id=?", [id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/supplier-products/:id
 * Visible: FOURNISSEUR (son shop), ADMIN
 */
router.delete("/:id", authRequired, requireRole("ADMIN", "FOURNISSEUR"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();

  try {
    const [[existing]] = await pool.query("SELECT * FROM supplier_products WHERE id=? LIMIT 1", [id]);
    if (!existing) return res.status(404).json({ error: "Not found" });

    if (!isAdmin(req.user)) {
      const [shops] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [req.user.id]
      );
      const myShop = shops && shops[0];
      if (!myShop) return res.status(403).json({ error: "No supplier shop linked to this user" });
      if (Number(existing.supplier_shop_id) !== Number(myShop.id)) return res.status(403).json({ error: "Forbidden" });
    }

    await pool.query("DELETE FROM supplier_products WHERE id=?", [id]);
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({ error: "PRODUCT_IN_USE" });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;