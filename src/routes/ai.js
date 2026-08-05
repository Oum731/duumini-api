// src/routes/ai.js
const { Router } = require("express");
const { authRequired, requireRole } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
const { upsertDraft } = require("../lib/contentStore");
const { env } = require("../lib/env");

const router = Router();

function isOff() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "OFF";
}

function ensureAiOn(res) {
  if (isOff()) {
    res.status(403).json({ error: "ai_mode_off" });
    return false;
  }
  if (!env.OPENAI_API_KEY) {
    res.status(500).json({ error: "OPENAI_API_KEY manquant" });
    return false;
  }
  return true;
}

/**
 * POST /api/ai/seo/optimize-page (ADMIN)
 * body: { slug, lang?, type?, current?, keywords?, internal_links? }
 * -> crée/maj un draft dans DB (content_items)
 */
router.post("/seo/optimize-page", authRequired, requireRole("ADMIN"), async (req, res) => {
  if (!ensureAiOn(res)) return;

  const {
    slug,
    lang = "fr",
    type = "page",
    current = null,
    keywords = [],
    internal_links = [],
  } = req.body || {};

  if (!slug) return res.status(400).json({ error: "slug requis" });

  try {
    const ai = await runDuuminiAgent("seo_optimize_page", {
      slug,
      lang,
      current,
      keywords,
      internal_links,
    });

    const saved = await upsertDraft({
      type,
      slug,
      lang,
      data: ai,
      score: ai?.score ?? null,
      created_by: "agent",
    });

    return res.json({
      ok: true,
      mode: env.DUUMINI_AI_MODE || "SAFE",
      draft: saved,
      preview: ai,
    });
  } catch (err) {
    return res.status(500).json({
      error: "seo_optimize_page_error",
      details: err?.message || String(err),
    });
  }
});

/**
 * POST /api/ai/seo/generate-city-page (ADMIN)
 * body: { city, slug?, lang?, keywords? }
 */
router.post("/seo/generate-city-page", authRequired, requireRole("ADMIN"), async (req, res) => {
  if (!ensureAiOn(res)) return;

  const { city, slug, lang = "fr", keywords = [] } = req.body || {};
  if (!city && !slug) return res.status(400).json({ error: "city ou slug requis" });

  try {
    const ai = await runDuuminiAgent("seo_generate_city_page", {
      city,
      slug,
      lang,
      keywords,
    });

    const finalSlug =
      slug ||
      String(city || "casablanca")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-") + "/produits-africains";

    const saved = await upsertDraft({
      type: "city_page",
      slug: finalSlug,
      lang,
      data: ai,
      score: ai?.score ?? null,
      created_by: "agent",
    });

    return res.json({
      ok: true,
      mode: env.DUUMINI_AI_MODE || "SAFE",
      draft: saved,
      preview: ai,
    });
  } catch (err) {
    return res.status(500).json({
      error: "seo_generate_city_page_error",
      details: err?.message || String(err),
    });
  }
});

/**
 * POST /api/ai/seo/audit (ADMIN)
 * body: { urls?: [] }
 */
router.post("/seo/audit", authRequired, requireRole("ADMIN"), async (req, res) => {
  if (!ensureAiOn(res)) return;

  try {
    const data = await runDuuminiAgent("seo_audit", req.body || {});
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", data });
  } catch (err) {
    return res.status(500).json({
      error: "seo_audit_error",
      details: err?.message || String(err),
    });
  }
});

const DUUMINI_COPY_TASKS = [
  "ads_meta",
  "ads_google",
  "campaign_meta",
  "campaign_google",
  "social_posts",
  "weekly_plan",
];

/**
 * POST /api/ai/duumini (ADMIN)
 * body: { taskType, payload? }
 * -> génération de texte marketing (ads/campagnes/posts/planning), pas de persistance
 */
router.post("/duumini", authRequired, requireRole("ADMIN"), async (req, res) => {
  if (!ensureAiOn(res)) return;

  const { taskType, payload = {} } = req.body || {};
  if (!DUUMINI_COPY_TASKS.includes(taskType)) {
    return res.status(400).json({ error: "taskType invalide", allowed: DUUMINI_COPY_TASKS });
  }

  try {
    const data = await runDuuminiAgent(taskType, payload);
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", data });
  } catch (err) {
    return res.status(500).json({
      error: "duumini_copy_error",
      details: err?.message || String(err),
    });
  }
});

module.exports = router;
