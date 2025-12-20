// src/routes/subCategories.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

function slugify(str) {
  return (
    String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || Date.now().toString(36)
  );
}

function toPositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * GET /api/sub-categories
 * Query:
 *  - page, pageSize
 *  - category_id? (optionnel)
 */
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const categoryId = toPositiveInt(req.query.category_id, null);

  try {
    const where = categoryId ? "WHERE sc.category_id = ?" : "";
    const params = categoryId ? [categoryId] : [];

    const [[{ total }]] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM sub_categories sc
      ${where}
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
      ${where}
      ORDER BY c.name ASC, sc.name ASC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/sub-categories
 * Body: { category_id, name, slug? }
 */
router.post("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();
  const { category_id, name, slug } = req.body || {};

  const categoryId = toPositiveInt(category_id, null);
  if (!categoryId) return res.status(400).json({ error: "category_id required" });

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name required" });
  }

  try {
    const [[cat]] = await pool.query(
      `SELECT id FROM categories WHERE id=? LIMIT 1`,
      [categoryId]
    );
    if (!cat) return res.status(400).json({ error: "category_id invalide" });

    const baseSlug =
      slug && String(slug).trim() ? String(slug).trim() : slugify(name);

    let finalSlug = baseSlug;
    let suffix = 1;

    // Unicité par category_id + slug
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count
           FROM sub_categories
          WHERE category_id=? AND slug=?`,
        [categoryId, finalSlug]
      );
      if (count === 0) break;
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    const [r] = await pool.query(
      `INSERT INTO sub_categories (category_id, name, slug)
       VALUES (?,?,?)`,
      [categoryId, name, finalSlug]
    );

    res.status(201).json({
      id: r.insertId,
      category_id: categoryId,
      name,
      slug: finalSlug,
    });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Duplicate slug for this category" });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/sub-categories/:id
 * Body: { category_id?, name?, slug? }
 */
router.put("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();
  const id = toPositiveInt(req.params.id, null);
  if (!id) return res.status(400).json({ error: "id invalide" });

  const { category_id, name, slug } = req.body || {};
  const newCategoryId = category_id != null ? toPositiveInt(category_id, null) : null;

  try {
    const [[row]] = await pool.query(
      `SELECT * FROM sub_categories WHERE id=? LIMIT 1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });

    let targetCategoryId = row.category_id;
    if (newCategoryId) {
      const [[cat]] = await pool.query(
        `SELECT id FROM categories WHERE id=? LIMIT 1`,
        [newCategoryId]
      );
      if (!cat) return res.status(400).json({ error: "category_id invalide" });
      targetCategoryId = newCategoryId;
    }

    const nextName = name != null ? String(name).trim() : row.name;

    let nextSlug = row.slug;
    if (slug != null) {
      const s = String(slug).trim();
      nextSlug = s ? s : slugify(nextName);
    } else if (name != null) {
      // si on change le name mais pas le slug => on garde slug existant (comportement stable)
      // si tu veux auto-regénérer, dis-moi.
      nextSlug = row.slug;
    }

    // Si slug/category change -> on s'assure de l'unicité (category_id, slug)
    const needsUniqCheck =
      String(targetCategoryId) !== String(row.category_id) || nextSlug !== row.slug;

    if (needsUniqCheck) {
      const baseSlug = nextSlug || slugify(nextName);
      let finalSlug = baseSlug;
      let suffix = 1;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [[{ count }]] = await pool.query(
          `SELECT COUNT(*) AS count
             FROM sub_categories
            WHERE category_id=? AND slug=? AND id<>?`,
          [targetCategoryId, finalSlug, id]
        );
        if (count === 0) break;
        finalSlug = `${baseSlug}-${suffix++}`;
      }
      nextSlug = finalSlug;
    }

    await pool.query(
      `UPDATE sub_categories SET
         category_id = ?,
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

/**
 * DELETE /api/sub-categories/:id
 */
router.delete("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();
  const id = toPositiveInt(req.params.id, null);
  if (!id) return res.status(400).json({ error: "id invalide" });

  try {
    const [r] = await pool.query(`DELETE FROM sub_categories WHERE id=?`, [id]);
    res.json({ ok: true, deleted: r.affectedRows > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
