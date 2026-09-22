// src/routes/adminContentAi.js
const { Router } = require("express");
const { authRequired, requireRole } = require("../middlewares/auth");
const {
  listContent,
  getContent,
  publishContent,
  unpublishContent,
  listVersions,
  rollbackToVersion,
  upsertDraft,
} = require("../lib/contentStore");

const router = Router();

/**
 * GET /api/admin/content-ai?status=draft&type=page&lang=fr&q=home
 */
router.get("/content-ai", authRequired, requireRole("ADMIN"), async (req, res) => {
  const { status, type, lang, q, limit, offset } = req.query || {};
  const rows = await listContent({
    status,
    type,
    lang,
    q,
    limit: Number(limit) || 50,
    offset: Number(offset) || 0,
  });
  return res.json({ ok: true, items: rows });
});

/**
 * POST /api/admin/content-ai/manual
 * body: { type, slug, lang?, data }
 * Crée/maj un draft directement depuis un JSON fourni par l'admin (contenu
 * rédigé à la main), sans passer par l'IA — indépendant des crédits
 * OpenAI/Anthropic, utile pour le SEO naturel (articles écrits soi-même).
 */
router.post("/content-ai/manual", authRequired, requireRole("ADMIN"), async (req, res) => {
  const { type, slug, lang = "fr", data } = req.body || {};
  if (!type || !slug) return res.status(400).json({ error: "type et slug requis" });
  if (!data || typeof data !== "object") return res.status(400).json({ error: "data (JSON) requis" });

  try {
    const saved = await upsertDraft({ type, slug, lang, data, score: null, created_by: "admin" });
    return res.json({ ok: true, draft: saved });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/content-ai/:id
 */
router.get("/content-ai/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  const item = await getContent(req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  return res.json({ ok: true, item });
});

/**
 * POST /api/admin/content-ai/:id/publish
 */
router.post("/content-ai/:id/publish", authRequired, requireRole("ADMIN"), async (req, res) => {
  const out = await publishContent(req.params.id, "admin");
  if (!out) return res.status(404).json({ error: "not_found" });
  return res.json({ ok: true, ...out });
});

/**
 * POST /api/admin/content-ai/:id/unpublish
 */
router.post("/content-ai/:id/unpublish", authRequired, requireRole("ADMIN"), async (req, res) => {
  const out = await unpublishContent(req.params.id, "admin");
  if (!out) return res.status(404).json({ error: "not_found" });
  return res.json({ ok: true, ...out });
});

/**
 * GET /api/admin/content-ai/:id/versions
 */
router.get("/content-ai/:id/versions", authRequired, requireRole("ADMIN"), async (req, res) => {
  const rows = await listVersions(req.params.id, 80);
  return res.json({ ok: true, versions: rows });
});

/**
 * POST /api/admin/content-ai/:id/rollback
 * body: { version_id }
 */
router.post("/content-ai/:id/rollback", authRequired, requireRole("ADMIN"), async (req, res) => {
  const { version_id } = req.body || {};
  if (!version_id) return res.status(400).json({ error: "version_id requis" });

  const out = await rollbackToVersion(req.params.id, version_id, "admin");
  if (!out) return res.status(404).json({ error: "not_found" });

  return res.json({ ok: true, ...out });
});

module.exports = router;
