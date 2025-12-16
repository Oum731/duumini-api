const express = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");

const router = express.Router();

function safeJsonParse(x, fallback = null) {
  if (x == null) return fallback;
  if (typeof x === "object") return x;
  try { return JSON.parse(String(x)); } catch { return fallback; }
}

/**
 * GET /api/page-copy/:slug?lang=fr
 * Retourne le copy publié (ou fallback si absent)
 */
router.get("/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const lang = String(req.query.lang || "fr").trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: "slug requis" });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, slug, lang, data_json, published_at, updated_at
         FROM page_copy
        WHERE slug=? AND lang=?
        LIMIT 1`,
      [slug, lang]
    );

    if (!rows.length) return res.json({ slug, lang, data: null });
    const r = rows[0];

    res.json({
      id: r.id,
      slug: r.slug,
      lang: r.lang,
      data: safeJsonParse(r.data_json, r.data_json),
      published_at: r.published_at,
      updated_at: r.updated_at,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/page-copy/:slug (ADMIN)
 * Remplace le contenu (manuel)
 * body: { lang?: "fr", data: {...}, reason?: "" }
 */
router.put(
  "/:slug",
  authRequired,
  requireRole("ADMIN"),
  async (req, res, next) => {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const lang = String(req.body?.lang || "fr").trim().toLowerCase();
    const data = req.body?.data;
    const reason = String(req.body?.reason || "manual_update").slice(0, 255);

    if (!slug) return res.status(400).json({ error: "slug requis" });
    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "data (object) requis" });
    }

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT id, data_json FROM page_copy WHERE slug=? AND lang=? LIMIT 1`,
        [slug, lang]
      );

      if (!rows.length) {
        const [ins] = await conn.query(
          `INSERT INTO page_copy (slug, lang, data_json, published_at)
           VALUES (?,?,?, NOW())`,
          [slug, lang, JSON.stringify(data)]
        );
        const pageId = ins.insertId;

        await conn.query(
          `INSERT INTO page_copy_versions (page_copy_id, slug, lang, data_json, reason, created_by)
           VALUES (?,?,?,?,?, 'admin')`,
          [pageId, slug, lang, JSON.stringify(data), reason]
        );

        await conn.commit();
        return res.json({ ok: true, created: true, id: pageId });
      }

      const pageId = rows[0].id;

      await conn.query(
        `UPDATE page_copy SET data_json=?, published_at=NOW() WHERE id=?`,
        [JSON.stringify(data), pageId]
      );

      await conn.query(
        `INSERT INTO page_copy_versions (page_copy_id, slug, lang, data_json, reason, created_by)
         VALUES (?,?,?,?,?, 'admin')`,
        [pageId, slug, lang, JSON.stringify(data), reason]
      );

      await conn.commit();
      res.json({ ok: true, id: pageId });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

/**
 * POST /api/page-copy/:slug/rollback (ADMIN)
 * body: { version_id }
 */
router.post(
  "/:slug/rollback",
  authRequired,
  requireRole("ADMIN"),
  async (req, res, next) => {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const versionId = Number(req.body?.version_id) || 0;
    if (!slug || !versionId) return res.status(400).json({ error: "version_id requis" });

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[ver]] = await conn.query(
        `SELECT v.id, v.page_copy_id, v.data_json, v.lang
           FROM page_copy_versions v
          WHERE v.id=? AND v.slug=?
          LIMIT 1`,
        [versionId, slug]
      );
      if (!ver) {
        await conn.rollback();
        return res.status(404).json({ error: "Version introuvable" });
      }

      await conn.query(
        `UPDATE page_copy SET data_json=?, published_at=NOW() WHERE id=?`,
        [ver.data_json, ver.page_copy_id]
      );

      await conn.query(
        `INSERT INTO page_copy_versions (page_copy_id, slug, lang, data_json, reason, created_by)
         VALUES (?,?,?,?, 'rollback', 'admin')`,
        [ver.page_copy_id, slug, ver.lang, ver.data_json]
      );

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
