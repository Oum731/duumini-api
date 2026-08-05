// api/routes/meta_ai_ads.js
const { Router } = require("express");
const { authRequired, requireRole } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
const { createAdCreative, createAd } = require("../lib/metaAds");
const { env } = require("../lib/env");

const router = Router();

function isOff() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "OFF";
}
function isAuto() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "AUTO";
}

/**
 * POST /api/ads/meta/auto
 * body: { offer, url, audience, objective, adset_id, page_id, autoActivate? }
 */
router.post("/meta/auto", authRequired, requireRole("ADMIN"), async (req, res) => {
  if (isOff()) {
    return res.status(403).json({ error: "ai_mode_off" });
  }

  const {
    offer = "Livraison de produits africains à Casablanca",
    url = env.DUUMINI_AI_MAIN_URL,
    audience = "Africains au Maroc et Marocains curieux",
    objective = "conversion (commandes)",
    adset_id,
    page_id,
    autoActivate = false,
  } = req.body || {};

  if (!adset_id || !page_id) {
    return res.status(400).json({ error: "adset_id et page_id requis" });
  }

  if (!env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY manquant" });
  }
  if (!env.META_AD_ACCOUNT_ID || !env.META_AD_ACCESS_TOKEN) {
    return res.status(500).json({ error: "META config manquante (account/token)" });
  }

  try {
    // SAFE: on force pause. AUTO: on respecte le param.
    const finalActivate = isAuto() ? !!autoActivate : false;

    const ai = await runDuuminiAgent("ads_meta", {
      objective,
      offer,
      url,
      audience,
      variants: 1,
    });

    const ad0 = ai?.ads?.[0];
    if (!ad0) {
      return res.status(500).json({ error: "IA n'a pas renvoyé de pub valide", raw: ai });
    }

    const primaryText = ad0.primary_text || "";
    const headline = ad0.headline || "";
    const description = ad0.description || "";
    const cta = ad0.call_to_action || "SHOP_NOW";

    const creative = await createAdCreative({
      name: `Duumini Creative - ${new Date().toISOString()}`,
      pageId: page_id,
      primaryText,
      headline,
      description,
      url,
      callToAction: cta,
    });

    const ad = await createAd({
      name: `Duumini Ad - ${new Date().toISOString()}`,
      adsetId: adset_id,
      creativeId: creative.id,
      status: finalActivate ? "ACTIVE" : "PAUSED",
    });

    return res.json({
      ok: true,
      mode: env.DUUMINI_AI_MODE || "SAFE",
      activated: finalActivate,
      ai,
      creative,
      ad,
    });
  } catch (err) {
    console.error("[META AI ADS] erreur:", err?.message, err?.meta || "");
    return res.status(500).json({
      error: "meta_ai_ads_error",
      details: err.message,
      meta: err.meta || undefined,
    });
  }
});

module.exports = router;
