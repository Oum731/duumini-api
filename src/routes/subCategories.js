// src/routes/subCategories.js
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

function toPositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseBoolFlag(value, defaultValue = null) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

/**
 * ✅ Vertical strict (même logique que products)
 * - accepte FOOD | MARKET | FASHION
 * - accepte alias: marché/marche -> MARKET
 * - retourne null si inconnu
 */
function normalizeVertical(value, fallback = null) {
  if (value == null) return fallback;

  const raw = String(value || "").trim();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const v = noAccent.trim().toUpperCase();

  if (v === "FOOD") return "FOOD";
  if (v === "MARKET" || v === "MARCHE" || v === "MARCHÉ") return "MARKET";
  if (v === "FASHION") return "FASHION";

  return fallback;
}

function pickRequestedVertical(req) {
  return normalizeVertical(req.query.vertical ?? req.query.v ?? req.query.type ?? null, null);
}

async function ensureUniqueSubSlug(pool, categoryId, baseSlug, ignoreId = null) {
  let finalSlug = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = ignoreId ? [categoryId, finalSlug, Number(ignoreId)] : [categoryId, finalSlug];
    const where = ignoreId ? "category_id=? AND slug=? AND id<>?" : "category_id=? AND slug=?";
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM sub_categories WHERE ${where}`,
      params
    );
    if (count === 0) break;
    finalSlug = `${baseSlug}-${suffix++}`;
  }
  return finalSlug;
}

/**
 * ✅ Quand on filtre par vertical, on veut aligner sur:
 * - vertical de la sub_category (colonne existante)
 * - + vertical de la category (si elle a aussi une colonne vertical)
 *
 * Ici, tu as confirmé: sub_categories.vertical existe.
 * categories.vertical existe aussi chez toi.
 */

/* =========================
 * GET /api/sub-categories
 * Query:
 *  - page, pageSize
 *  - category_id? (optionnel)
 *  - vertical? (optionnel) => FOOD|MARKET|FASHION
 *  - q? (optionnel) recherche sur name/slug
 *  - onlyActive=1 (optionnel) si colonne is_active existe (sub_categories et/ou categories)
 * =======================*/
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const categoryId =
    toPositiveInt(req.query.category_id, null) ?? toPositiveInt(req.query.categoryId, null);

  const q = String(req.query.q || "").trim().toLowerCase();
  const vReq = pickRequestedVertical(req);
  const onlyActive = parseBoolFlag(req.query.onlyActive, null);

  try {
    // détecter si categories a une colonne vertical/is_active (sans casser si absent)
    const conn = await pool.getConnection();
    let categoriesHasVertical = false;
    let catActiveCol = null;
    let scActiveCol = null;
    try {
      const [cCols] = await conn.query(
        `
        SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME='categories'
           AND COLUMN_NAME IN ('vertical','is_active','active','enabled')
        `
      );
      const cSet = new Set((cCols || []).map((r) => r.COLUMN_NAME));
      categoriesHasVertical = cSet.has("vertical");
      catActiveCol = cSet.has("is_active")
        ? "is_active"
        : cSet.has("active")
        ? "active"
        : cSet.has("enabled")
        ? "enabled"
        : null;

      const [scCols] = await conn.query(
        `
        SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME='sub_categories'
           AND COLUMN_NAME IN ('is_active','active','enabled')
        `
      );
      const scSet = new Set((scCols || []).map((r) => r.COLUMN_NAME));
      scActiveCol = scSet.has("is_active")
        ? "is_active"
        : scSet.has("active")
        ? "active"
        : scSet.has("enabled")
        ? "enabled"
        : null;
    } finally {
      conn.release();
    }

    const whereParts = ["1=1"];
    const params = [];

    if (categoryId) {
      whereParts.push("sc.category_id = ?");
      params.push(categoryId);
    }

    // ✅ Filtre vertical: on filtre d'abord sur sc.vertical, et si categories.vertical existe, on l'aligne aussi
    if (vReq) {
      whereParts.push("UPPER(TRIM(COALESCE(sc.vertical,''))) = ?");
      params.push(vReq);

      if (categoriesHasVertical) {
        whereParts.push("UPPER(TRIM(COALESCE(c.vertical,''))) = ?");
        params.push(vReq);
      }
    }

    if (q) {
      whereParts.push("(LOWER(sc.name) LIKE ? OR LOWER(sc.slug) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like);
    }

    // ✅ Active filtering
    const isAdminUser = isAdmin && isAdmin(req.user);
    const enforceActiveForPublic = !isAdminUser;
    const wantOnlyActive = onlyActive === null ? enforceActiveForPublic : onlyActive === 1;

    if (wantOnlyActive) {
      if (scActiveCol) whereParts.push(`sc.${scActiveCol} = 1`);
      if (catActiveCol) whereParts.push(`c.${catActiveCol} = 1`);
    }

    const whereSql = whereParts.join(" AND ");

    const [[{ total }]] = await pool.query(
      `
      SELECT COUNT(*) AS total
        FROM sub_categories sc
        JOIN categories c ON c.id = sc.category_id
       WHERE ${whereSql}
      `,
      params
    );

    const [rows] = await pool.query(
      `
      SELECT
        sc.*,
        c.name AS category_name,
        c.slug AS category_slug
      FROM sub_categories sc
      JOIN categories c ON c.id = sc.category_id
      WHERE ${whereSql}
      ORDER BY c.name ASC, sc.name ASC
      LIMIT ? OFFSET ?
      `,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/sub-categories (ADMIN)
 * Body: { category_id, name, slug?, vertical? }
 * - ✅ vertical obligatoire (FOOD|MARKET|FASHION) puisque ta colonne existe
 * - ✅ on force l'alignement sur categories.vertical si elle existe
 * =======================*/
router.post("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  const categoryId = toPositiveInt(req.body?.category_id ?? req.body?.categoryId, null);
  const name = String(req.body?.name || "").trim();
  const rawSlug = String(req.body?.slug || "").trim();

  // ✅ vertical
  const v = normalizeVertical(req.body?.vertical, null);

  if (!categoryId) return res.status(400).json({ error: "category_id required" });
  if (!name) return res.status(400).json({ error: "name required" });
  if (!v) return res.status(400).json({ error: "vertical required (FOOD|MARKET|FASHION)" });

  try {
    // récupérer la catégorie + vérifier alignment vertical si la colonne existe
    const [[cat]] = await pool.query(`SELECT * FROM categories WHERE id=? LIMIT 1`, [categoryId]);
    if (!cat) return res.status(400).json({ error: "category_id invalide" });

    if (Object.prototype.hasOwnProperty.call(cat, "vertical") && cat.vertical != null) {
      const catV = normalizeVertical(cat.vertical, null);
      if (catV && catV !== v) {
        return res.status(400).json({
          error: "VERTICAL_MISMATCH",
          message: "Le vertical de la sous-catégorie doit correspondre au vertical de la catégorie.",
        });
      }
    }

    const baseSlug = rawSlug ? slugify(rawSlug) : slugify(name);
    const finalSlug = await ensureUniqueSubSlug(pool, categoryId, baseSlug);

    // ✅ vertical stocké dans sub_categories.vertical
    const [r] = await pool.query(
      `INSERT INTO sub_categories (category_id, name, slug, vertical)
       VALUES (?,?,?,?)`,
      [categoryId, name, finalSlug, v]
    );

    res.status(201).json({
      id: r.insertId,
      category_id: categoryId,
      name,
      slug: finalSlug,
      vertical: v,
    });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Duplicate slug for this category" });
    }
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * PUT /api/sub-categories/:id (ADMIN)
 * Body: { category_id?, name?, slug?, vertical? }
 * - ✅ vertical validé (FOOD|MARKET|FASHION)
 * - ✅ si category change => on valide l'alignement vertical avec la catégorie (si categories.vertical existe)
 * =======================*/
router.put("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  const id = toPositiveInt(req.params.id, null);
  if (!id) return res.status(400).json({ error: "id invalide" });

  const incomingCategoryId = req.body?.category_id ?? req.body?.categoryId;
  const newCategoryId = incomingCategoryId != null ? toPositiveInt(incomingCategoryId, null) : null;

  const hasName = req.body?.name !== undefined;
  const hasSlug = req.body?.slug !== undefined;
  const hasVertical = req.body?.vertical !== undefined;

  try {
    const [[row]] = await pool.query(`SELECT * FROM sub_categories WHERE id=? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    let targetCategoryId = Number(row.category_id);

    if (newCategoryId) {
      const [[cat]] = await pool.query(`SELECT * FROM categories WHERE id=? LIMIT 1`, [newCategoryId]);
      if (!cat) return res.status(400).json({ error: "category_id invalide" });
      targetCategoryId = Number(newCategoryId);
    } else {
      const [[cat]] = await pool.query(`SELECT * FROM categories WHERE id=? LIMIT 1`, [targetCategoryId]);
      if (!cat) return res.status(400).json({ error: "category_id invalide" });
    }

    const nextName = hasName ? String(req.body?.name || "").trim() : String(row.name || "").trim();
    if (!nextName) return res.status(400).json({ error: "name cannot be empty" });

    let nextSlug = String(row.slug || "").trim();
    if (hasSlug) {
      const s = String(req.body?.slug || "").trim();
      nextSlug = s ? slugify(s) : slugify(nextName);
    }

    // ✅ vertical
    let nextVertical = normalizeVertical(row.vertical, null);
    if (hasVertical) {
      const vv = normalizeVertical(req.body?.vertical, null);
      if (!vv) return res.status(400).json({ error: "vertical invalid (FOOD|MARKET|FASHION)" });
      nextVertical = vv;
    }
    if (!nextVertical) {
      // tu as dit: la colonne existe => on exige une valeur valide
      return res.status(400).json({ error: "vertical required (FOOD|MARKET|FASHION)" });
    }

    // ✅ alignement vertical avec la catégorie si categories.vertical existe
    const [[catRow]] = await pool.query(`SELECT * FROM categories WHERE id=? LIMIT 1`, [targetCategoryId]);
    if (!catRow) return res.status(400).json({ error: "category_id invalide" });

    if (Object.prototype.hasOwnProperty.call(catRow, "vertical") && catRow.vertical != null) {
      const catV = normalizeVertical(catRow.vertical, null);
      if (catV && catV !== nextVertical) {
        return res.status(400).json({
          error: "VERTICAL_MISMATCH",
          message: "Le vertical de la sous-catégorie doit correspondre au vertical de la catégorie.",
        });
      }
    }

    const needsUniqCheck =
      String(targetCategoryId) !== String(row.category_id) ||
      (hasSlug && nextSlug !== String(row.slug || "").trim());

    if (needsUniqCheck) {
      const baseSlug = nextSlug || slugify(nextName);
      nextSlug = await ensureUniqueSubSlug(pool, targetCategoryId, baseSlug, id);
    }

    await pool.query(
      `UPDATE sub_categories
          SET category_id = ?,
              name = ?,
              slug = ?,
              vertical = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [targetCategoryId, nextName, nextSlug, nextVertical, id]
    );

    res.json({
      ok: true,
      id,
      category_id: targetCategoryId,
      name: nextName,
      slug: nextSlug,
      vertical: nextVertical,
    });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Duplicate slug for this category" });
    }
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * DELETE /api/sub-categories/:id (ADMIN)
 * - bloque si des products utilisent cette sub_category
 * =======================*/
router.delete("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  const id = toPositiveInt(req.params.id, null);
  if (!id) return res.status(400).json({ error: "id invalide" });

  try {
    const [[row]] = await pool.query(
      `SELECT id, category_id FROM sub_categories WHERE id=? LIMIT 1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });

    try {
      const [[{ pCount }]] = await pool.query(
        `SELECT COUNT(*) AS pCount FROM products WHERE sub_category_id=?`,
        [id]
      );
      if (Number(pCount || 0) > 0) {
        return res.status(409).json({
          error: "SUB_CATEGORY_IN_USE",
          message: "Impossible de supprimer: des produits utilisent cette sous-catégorie.",
        });
      }
    } catch {}

    const [r] = await pool.query(`DELETE FROM sub_categories WHERE id=?`, [id]);
    res.json({ ok: true, deleted: r.affectedRows > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;