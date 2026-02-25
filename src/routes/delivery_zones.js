// src/routes/delivery_zones.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

function parseBoolFlag(value, defaultValue = null) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

/**
 * GET /api/delivery-zones
 * Query:
 *  - city?      (ex: Casablanca)
 *  - q?         (recherche zone_name)
 *  - onlyActive? (1/0)
 *  - page/pageSize
 */
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const city = String(req.query.city || "").trim();
  const q = String(req.query.q || "").trim();
  const onlyActive = parseBoolFlag(req.query.onlyActive, 1);

  try {
    const where = ["1=1"];
    const params = [];

    if (city) {
      where.push("LOWER(TRIM(city)) = LOWER(TRIM(?))");
      params.push(city);
    }
    if (q) {
      where.push("LOWER(zone_name) LIKE ?");
      params.push(`%${q.toLowerCase()}%`);
    }
    if (onlyActive === 1) {
      where.push("is_active = 1");
    }

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM delivery_zones WHERE ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `
      SELECT dz.*
      FROM delivery_zones dz
      WHERE ${whereSql}
      ORDER BY dz.city ASC, dz.zone_name ASC
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
 * POST /api/delivery-zones (ADMIN)
 * Body:
 *  - city, zone_name, base_fee
 *  - pickup_type? ('ADDRESS'|'VENDOR_POINT')
 *  - pickup_vendor_shop_id?
 *  - is_active?
 */
router.post("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  try {
    const city = String(req.body?.city || "").trim();
    const zone_name = String(req.body?.zone_name || "").trim();
    const base_fee = Number(req.body?.base_fee || 0);
    const pickup_type = String(req.body?.pickup_type || "ADDRESS").toUpperCase();
    const pickup_vendor_shop_id =
      req.body?.pickup_vendor_shop_id != null ? Number(req.body.pickup_vendor_shop_id) : null;
    const is_active =
      req.body?.is_active != null ? Number(req.body.is_active ? 1 : 0) : 1;

    if (!city) return res.status(400).json({ error: "city required" });
    if (!zone_name) return res.status(400).json({ error: "zone_name required" });
    if (!Number.isFinite(base_fee) || base_fee < 0) return res.status(400).json({ error: "base_fee invalid" });

    if (!["ADDRESS", "VENDOR_POINT"].includes(pickup_type)) {
      return res.status(400).json({ error: "pickup_type invalid" });
    }

    const [r] = await pool.query(
      `
      INSERT INTO delivery_zones
        (city, zone_name, base_fee, pickup_type, pickup_vendor_shop_id, is_active)
      VALUES (?,?,?,?,?,?)
      `,
      [city, zone_name, base_fee, pickup_type, pickup_vendor_shop_id, is_active]
    );

    const [rows] = await pool.query(
      "SELECT * FROM delivery_zones WHERE id=?",
      [r.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "ZONE_ALREADY_EXISTS" });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/delivery-zones/:id (ADMIN)
 */
router.put("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();

  try {
    const [[existing]] = await pool.query(
      "SELECT * FROM delivery_zones WHERE id=? LIMIT 1",
      [id]
    );
    if (!existing) return res.status(404).json({ error: "Not found" });

    const patch = {};
    const set = [];
    const params = [];

    const fields = ["city", "zone_name", "base_fee", "pickup_type", "pickup_vendor_shop_id", "is_active"];
    for (const f of fields) {
      if (req.body?.[f] !== undefined) {
        patch[f] = req.body[f];
      }
    }

    if (patch.city !== undefined) {
      const v = String(patch.city || "").trim();
      if (!v) return res.status(400).json({ error: "city invalid" });
      set.push("city=?"); params.push(v);
    }

    if (patch.zone_name !== undefined) {
      const v = String(patch.zone_name || "").trim();
      if (!v) return res.status(400).json({ error: "zone_name invalid" });
      set.push("zone_name=?"); params.push(v);
    }

    if (patch.base_fee !== undefined) {
      const v = Number(patch.base_fee);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "base_fee invalid" });
      set.push("base_fee=?"); params.push(v);
    }

    if (patch.pickup_type !== undefined) {
      const v = String(patch.pickup_type || "ADDRESS").toUpperCase();
      if (!["ADDRESS", "VENDOR_POINT"].includes(v)) return res.status(400).json({ error: "pickup_type invalid" });
      set.push("pickup_type=?"); params.push(v);
    }

    if (patch.pickup_vendor_shop_id !== undefined) {
      const v = patch.pickup_vendor_shop_id == null ? null : Number(patch.pickup_vendor_shop_id);
      if (v != null && (!Number.isFinite(v) || v <= 0)) return res.status(400).json({ error: "pickup_vendor_shop_id invalid" });
      set.push("pickup_vendor_shop_id=?"); params.push(v);
    }

    if (patch.is_active !== undefined) {
      const v = Number(patch.is_active ? 1 : 0);
      set.push("is_active=?"); params.push(v);
    }

    if (!set.length) return res.json({ ok: true });

    params.push(id);
    await pool.query(`UPDATE delivery_zones SET ${set.join(", ")} WHERE id=?`, params);

    const [rows] = await pool.query("SELECT * FROM delivery_zones WHERE id=?", [id]);
    res.json(rows[0]);
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "ZONE_ALREADY_EXISTS" });
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/delivery-zones/:id (ADMIN)
 */
router.delete("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();
  try {
    const [[row]] = await pool.query("SELECT id FROM delivery_zones WHERE id=? LIMIT 1", [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    await pool.query("DELETE FROM delivery_zones WHERE id=?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;