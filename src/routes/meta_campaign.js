// src/routes/meta_campaign.js
const { Router } = require("express");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
const { putDraft, getDraft, delDraft } = require("../lib/aiDraftStore");
const { createCampaign, createAdSet, createAdCreative, createAd, buildTargeting } = require("../lib/metaAds");
const { env } = require("../lib/env");

const router = Router();

function isOff() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "OFF";
}
function isAuto() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "AUTO";
}

/**
 * POST /api/ads/meta/build
 * body (optionnel): { objective, offer, url, audience, daily_budget_mad, days, city_focus }
 * -> retourne draft_id + preview (campagne complète)
 */
router.post("/meta/build", authRequired, isAdmin, async (req, res) => {
  if (isOff()) return res.status(403).json({ error: "ai_mode_off" });
  if (!env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY manquant" });

  const payload = req.body || {};
  try {
    const ai = await runDuuminiAgent("campaign_meta", payload);

    const meta = ai?.meta;
    if (!meta?.campaign || !meta?.adset || !meta?.creative) {
      return res.status(500).json({ error: "IA n'a pas renvoyé une campagne meta valide", raw: ai });
    }

    const info = putDraft("meta", meta);
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", draft_id: info.id, preview: meta });
  } catch (err) {
    return res.status(500).json({ error: "meta_build_error", details: err.message });
  }
});

/**
 * POST /api/ads/meta/publish
 * body: { draft_id, activate?: boolean }
 * - SAFE: toujours PAUSED
 * - AUTO: activate si activate=true
 */
router.post("/meta/publish", authRequired, isAdmin, async (req, res) => {
  if (isOff()) return res.status(403).json({ error: "ai_mode_off" });

  const { draft_id, activate = false } = req.body || {};
  const d = getDraft(draft_id);
  if (!d || d.type !== "meta") return res.status(404).json({ error: "draft_not_found" });

  if (!env.META_AD_ACCOUNT_ID || !env.META_AD_ACCESS_TOKEN) {
    return res.status(500).json({ error: "META config manquante (account/token)" });
  }

  const finalActivate = isAuto() ? !!activate : false;
  const status = finalActivate ? "ACTIVE" : "PAUSED";

  const meta = d.payload || {};
  const pageId = env.META_PAGE_ID;
  if (!pageId) return res.status(500).json({ error: "META_PAGE_ID manquant" });

  try {
    // 1) Campaign
    const campaign = await createCampaign({
      name: meta.campaign?.name,
      objective: meta.campaign?.objective || env.META_CAMPAIGN_OBJECTIVE || "OUTCOME_SALES",
      status: "PAUSED", // on garde safe au niveau campaign; ad decide status
    });

    // 2) AdSet
    const targeting = buildTargeting(meta.adset?.targeting_hint || {});
    const adset = await createAdSet({
      name: meta.adset?.name,
      campaignId: campaign.id,
      dailyBudgetMad: meta.adset?.daily_budget_mad || 80,
      targeting,
      status: "PAUSED",
    });

    // 3) Creative
    const creative = await createAdCreative({
      name: `Duumini Creative - ${new Date().toISOString()}`,
      pageId,
      primaryText: meta.creative?.primary_text,
      headline: meta.creative?.headline,
      description: meta.creative?.description,
      url: env.DUUMINI_AI_MAIN_URL || "https://duumini.com",
      callToAction: meta.creative?.call_to_action || "SHOP_NOW",
    });

    // 4) Ad
    const ad = await createAd({
      name: `Duumini Ad - ${new Date().toISOString()}`,
      adsetId: adset.id,
      creativeId: creative.id,
      status, // ACTIVE/PAUSED
    });

    // (optionnel) on supprime le draft après publication
    delDraft(draft_id);

    return res.json({
      ok: true,
      mode: env.DUUMINI_AI_MODE || "SAFE",
      activated: finalActivate,
      campaign,
      adset,
      creative,
      ad,
      preview: meta,
    });
  } catch (err) {
    return res.status(500).json({
      error: "meta_publish_error",
      details: err.message,
      meta: err.meta || undefined,
    });
  }
});

module.exports = router;
