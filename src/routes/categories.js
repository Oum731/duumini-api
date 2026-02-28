// src/routes/categories.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

/* =========================
 * Helpers
 * =======================*/

function slugify(str) {
  const out =
    String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return out || Date.now().toString(36);
}

function parseBoolFlag(value, defaultValue = null) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

async function detectColumn(conn, tableName, candidates) {
  const [rows] = await conn.query(
    `
    SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    [tableName, ...candidates]
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return candidates.find((c) => found.has(c)) || null;
}

let _catsColumns = null;
let _catsColumnsLoaded = false;

async function getCategoriesColumns(pool) {
  if (_catsColumnsLoaded) return _catsColumns;

  const conn = await pool.getConnection();
  try {
    const verticalCol = await detectColumn(conn, "categories", ["vertical"]);
    const isActiveCol = await detectColumn(conn, "categories", ["is_active", "active", "enabled"]);

    _catsColumns = { verticalCol, isActiveCol };
    _catsColumnsLoaded = true;
    return _catsColumns;
  } finally {
    conn.release();
  }
}

/**
 * ✅ Vertical strict + alias
 * - FOOD | MARKET | FASHION
 * - alias: marché/marche -> MARKET
 * - alias: african-food -> FOOD, african-market -> MARKET, fashionstyle -> FASHION
 */
function normalizeVertical(value) {
  if (value == null) return null;

  const raw = String(value || "").trim();
  if (!raw) return null;

  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const v = noAccent.trim().toUpperCase();

  if (v === "FOOD") return "FOOD";
  if (v === "MARKET" || v === "MARCHE" || v === "MARCHÉ") return "MARKET";
  if (v === "FASHION") return "FASHION";

  const low = v.toLowerCase();
  if (low === "african-food") return "FOOD";
  if (low === "african-market") return "MARKET";
  if (low === "fashionstyle") return "FASHION";

  return null;
}

function pickRequestedVertical(req) {
  const v = req.query.vertical ?? req.query.v ?? req.query.type ?? req.query.channel ?? null;
  return normalizeVertical(v);
}

async function ensureUniqueSlug(pool, baseSlug, ignoreId = null) {
  let finalSlug = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = ignoreId ? [finalSlug, Number(ignoreId)] : [finalSlug];
    const where = ignoreId ? "slug=? AND id<>?" : "slug=?";
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM categories WHERE ${where}`,
      params
    );
    if (count === 0) break;
    finalSlug = `${baseSlug}-${suffix++}`;
  }
  return finalSlug;
}

/* =========================
 * GET /api/categories
 * =======================*/
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const q = String(req.query.q || "").trim().toLowerCase();
  const reqVertical = pickRequestedVertical(req);
  const onlyActive = parseBoolFlag(req.query.onlyActive, null);

  try {
    const cols = await getCategoriesColumns(pool);

    const whereParts = ["1=1"];
    const params = [];

    if (cols.verticalCol && reqVertical) {
      whereParts.push(`UPPER(TRIM(COALESCE(${cols.verticalCol},''))) = ?`);
      params.push(reqVertical);
    }

    if (q) {
      whereParts.push(`(LOWER(name) LIKE ? OR LOWER(slug) LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like);
    }

    const isAdminUser = isAdmin && isAdmin(req.user);
    const hasActiveCol = !!cols.isActiveCol;

    if (hasActiveCol) {
      const enforceActiveForPublic = !isAdminUser;
      const wantOnlyActive = onlyActive === null ? enforceActiveForPublic : onlyActive === 1;
      if (wantOnlyActive) whereParts.push(`${cols.isActiveCol} = 1`);
    }

    const whereSql = whereParts.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM categories WHERE ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT * FROM categories WHERE ${whereSql} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/categories (ADMIN)
 * =======================*/
router.post("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const cols = await getCategoriesColumns(pool);

    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });

    const rawSlug = String(req.body?.slug || "").trim();
    const baseSlug = rawSlug ? slugify(rawSlug) : slugify(name);
    const finalSlug = await ensureUniqueSlug(pool, baseSlug);

    // ✅ vertical: on ne laisse jamais NULL si colonne existe
    let vertical = null;
    if (cols.verticalCol) {
      const provided = req.body?.vertical !== undefined;
      vertical = normalizeVertical(req.body?.vertical);

      // si vertical fourni mais invalide -> 400
      if (provided && !vertical) {
        return res.status(400).json({ error: "vertical invalid (FOOD|MARKET|FASHION)" });
      }

      // si pas fourni -> default safe (évite NOT NULL / enum)
      if (!vertical) vertical = "MARKET";
    }

    const active = cols.isActiveCol ? parseBoolFlag(req.body?.is_active, 1) : null;

    const fields = ["name", "slug"];
    const values = [name, finalSlug];

    if (cols.verticalCol) {
      fields.push(cols.verticalCol);
      values.push(vertical);
    }

    if (cols.isActiveCol) {
      fields.push(cols.isActiveCol);
      values.push(active == null ? 1 : active);
    }

    const sql = `INSERT INTO categories (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`;
    const [r] = await conn.query(sql, values);

    res.status(201).json({
      id: r.insertId,
      name,
      slug: finalSlug,
      ...(cols.verticalCol ? { vertical } : {}),
      ...(cols.isActiveCol ? { is_active: values[fields.indexOf(cols.isActiveCol)] } : {}),
    });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Duplicate slug" });
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * PUT /api/categories/:id (ADMIN)
 * =======================*/
router.put("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const cols = await getCategoriesColumns(pool);

    const [[row]] = await conn.query(`SELECT * FROM categories WHERE id=? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    const patch = {};

    if (req.body?.name !== undefined) {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name cannot be empty" });
      patch.name = name;
    }

    if (req.body?.slug !== undefined) {
      const rawSlug = String(req.body?.slug || "").trim();
      const baseSlug = rawSlug ? slugify(rawSlug) : slugify(patch.name || row.name);
      patch.slug = await ensureUniqueSlug(pool, baseSlug, id);
    }

    if (cols.verticalCol && req.body?.vertical !== undefined) {
      const v = normalizeVertical(req.body?.vertical);
      if (!v) return res.status(400).json({ error: "vertical invalid (FOOD|MARKET|FASHION)" });
      patch[cols.verticalCol] = v;
    }

    if (cols.isActiveCol && req.body?.is_active !== undefined) {
      const active = parseBoolFlag(req.body?.is_active, null);
      if (active === null) return res.status(400).json({ error: "is_active invalid" });
      patch[cols.isActiveCol] = active;
    }

    const keys = Object.keys(patch);
    if (!keys.length) return res.json({ ok: true });

    const setSql = keys.map((k) => `${k}=?`).join(", ");
    const params = keys.map((k) => patch[k]);
    params.push(id);

    await conn.query(`UPDATE categories SET ${setSql} WHERE id=?`, params);

    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Duplicate slug" });
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * DELETE /api/categories/:id (ADMIN)
 * =======================*/
router.delete("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [[row]] = await conn.query(`SELECT id FROM categories WHERE id=? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    try {
      const [[{ scCount }]] = await conn.query(
        `SELECT COUNT(*) AS scCount FROM sub_categories WHERE category_id=?`,
        [id]
      );
      if (Number(scCount || 0) > 0) {
        return res.status(409).json({
          error: "CATEGORY_IN_USE",
          message: "Impossible de supprimer: des sous-catégories existent pour cette catégorie.",
        });
      }
    } catch {}

    try {
      const [[{ pCount }]] = await conn.query(
        `SELECT COUNT(*) AS pCount FROM products WHERE category_id=?`,
        [id]
      );
      if (Number(pCount || 0) > 0) {
        return res.status(409).json({
          error: "CATEGORY_IN_USE",
          message: "Impossible de supprimer: des produits utilisent cette catégorie.",
        });
      }
    } catch {}

    await conn.query(`DELETE FROM categories WHERE id=?`, [id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;