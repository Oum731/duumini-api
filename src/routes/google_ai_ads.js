// api/routes/google_ai_ads.js
const { Router } = require("express");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
const { env } = require("../lib/env");

const router = Router();

function isOff() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "OFF";
}

/**
 * POST /api/ads/google/generate
 * body: { objective, offer, url, audience, variants }
 */
router.post("/google/generate", authRequired, isAdmin, async (req, res) => {
  if (isOff()) {
    return res.status(403).json({ error: "ai_mode_off" });
  }

  const {
    objective = "vente en ligne de produits africains",
    offer = "épicerie et plats africains livrés à Casablanca",
    url = env.DUUMINI_AI_MAIN_URL,
    audience = "personnes au Maroc cherchant des produits africains",
    variants = 3,
  } = req.body || {};

  if (!env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY manquant" });
  }

  try {
    const ai = await runDuuminiAgent("ads_google", {
      objective,
      offer,
      url,
      audience,
      variants,
    });

    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", data: ai });
  } catch (err) {
    console.error("[GOOGLE AI ADS] erreur:", err);
    return res.status(500).json({ error: "google_ai_ads_error", details: err.message });
  }
});

module.exports = router;
