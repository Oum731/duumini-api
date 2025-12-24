// src/routes/subCategories.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
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

/* =========================
 * GET /api/sub-categories
 * Query:
 *  - page, pageSize
 *  - category_id? (optionnel)
 *  - q? (optionnel) recherche sur name/slug
 * =======================*/
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const categoryId =
    toPositiveInt(req.query.category_id, null) ??
    toPositiveInt(req.query.categoryId, null);

  const q = String(req.query.q || "").trim().toLowerCase();

  try {
    const whereParts = ["1=1"];
    const params = [];

    if (categoryId) {
      whereParts.push("sc.category_id = ?");
      params.push(categoryId);
    }

    if (q) {
      whereParts.push("(LOWER(sc.name) LIKE ? OR LOWER(sc.slug) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like);
    }

    const whereSql = whereParts.join(" AND ");

    const [[{ total }]] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM sub_categories sc
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
 * Body: { category_id, name, slug? }
 * =======================*/
router.post("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  const categoryId = toPositiveInt(req.body?.category_id ?? req.body?.categoryId, null);
  const name = String(req.body?.name || "").trim();
  const rawSlug = String(req.body?.slug || "").trim();

  if (!categoryId) return res.status(400).json({ error: "category_id required" });
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const [[cat]] = await pool.query(`SELECT id FROM categories WHERE id=? LIMIT 1`, [categoryId]);
    if (!cat) return res.status(400).json({ error: "category_id invalide" });

    const baseSlug = rawSlug ? slugify(rawSlug) : slugify(name);
    const finalSlug = await ensureUniqueSubSlug(pool, categoryId, baseSlug);

    const [r] = await pool.query(
      `INSERT INTO sub_categories (category_id, name, slug)
       VALUES (?,?,?)`,
      [categoryId, name, finalSlug]
    );

    res.status(201).json({ id: r.insertId, category_id: categoryId, name, slug: finalSlug });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Duplicate slug for this category" });
    }
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * PUT /api/sub-categories/:id (ADMIN)
 * Body: { category_id?, name?, slug? }
 * - slug auto si name change et slug absent
 * - slug unique dans la catégorie (category_id + slug)
 * =======================*/
router.put("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  const id = toPositiveInt(req.params.id, null);
  if (!id) return res.status(400).json({ error: "id invalide" });

  const incomingCategoryId = req.body?.category_id ?? req.body?.categoryId;
  const newCategoryId = incomingCategoryId != null ? toPositiveInt(incomingCategoryId, null) : null;

  const hasName = req.body?.name !== undefined;
  const hasSlug = req.body?.slug !== undefined;

  try {
    const [[row]] = await pool.query(`SELECT * FROM sub_categories WHERE id=? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    let targetCategoryId = Number(row.category_id);

    if (newCategoryId) {
      const [[cat]] = await pool.query(`SELECT id FROM categories WHERE id=? LIMIT 1`, [newCategoryId]);
      if (!cat) return res.status(400).json({ error: "category_id invalide" });
      targetCategoryId = Number(newCategoryId);
    }

    const nextName = hasName ? String(req.body?.name || "").trim() : String(row.name || "").trim();
    if (!nextName) return res.status(400).json({ error: "name cannot be empty" });

    // slug logique :
    // - si slug fourni: on le slugify (ou auto si vide)
    // - sinon si name change: on conserve slug existant (comme ton code) (tu peux changer ici si tu veux auto)
    let nextSlug = String(row.slug || "").trim();

    if (hasSlug) {
      const s = String(req.body?.slug || "").trim();
      nextSlug = s ? slugify(s) : slugify(nextName);
    }

    // Unicité si:
    // - catégorie change
    // - ou slug change (ou auto généré via hasSlug)
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
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [targetCategoryId, nextName, nextSlug, id]
    );

    res.json({ ok: true, id, category_id: targetCategoryId, name: nextName, slug: nextSlug });
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
    const [[row]] = await pool.query(`SELECT id, category_id FROM sub_categories WHERE id=? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });

    // Empêche suppression si utilisée par des produits
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
    } catch {
      // ignore si table products absente dans un env
    }

    const [r] = await pool.query(`DELETE FROM sub_categories WHERE id=?`, [id]);
    res.json({ ok: true, deleted: r.affectedRows > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
