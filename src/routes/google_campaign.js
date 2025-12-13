// src/routes/google_campaign.js
const { Router } = require("express");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
const { putDraft, getDraft } = require("../lib/aiDraftStore");
const { env } = require("../lib/env");

const router = Router();

function isOff() {
  return String(env.DUUMINI_AI_MODE || "SAFE").toUpperCase() === "OFF";
}

function csvEscape(s) {
  const v = String(s ?? "");
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * CSV simple importable (Google Ads Editor -> Ads/Keywords via colonnes)
 * Tu peux l'ajuster selon ton workflow.
 */
function toGoogleCsv(google) {
  const campaign = google.campaign_name || "Duumini Campaign";
  const adgroup = google.adgroup_name || "AdGroup 1";
  const url = google.final_url || env.DUUMINI_AI_MAIN_URL || "https://duumini.com";

  const lines = [];
  lines.push([
    "Campaign",
    "Ad Group",
    "Final URL",
    "Keyword",
    "Match Type",
    "Headline 1",
    "Headline 2",
    "Headline 3",
    "Description 1",
    "Description 2",
    "Path 1",
    "Path 2",
  ].map(csvEscape).join(","));

  const ads = google.ads || [];
  const ad0 = ads[0] || {};
  const h = ad0.headlines || [];
  const d = ad0.descriptions || [];

  const keywords = google.keywords || [];
  if (keywords.length) {
    for (const kw of keywords) {
      lines.push([
        campaign,
        adgroup,
        url,
        kw.text || "",
        (kw.match || "PHRASE").toUpperCase(),
        h[0] || "",
        h[1] || "",
        h[2] || "",
        d[0] || "",
        d[1] || "",
        ad0.path1 || "",
        ad0.path2 || "",
      ].map(csvEscape).join(","));
    }
  } else {
    lines.push([
      campaign, adgroup, url, "", "", h[0] || "", h[1] || "", h[2] || "", d[0] || "", d[1] || "", ad0.path1 || "", ad0.path2 || ""
    ].map(csvEscape).join(","));
  }

  return lines.join("\n");
}

/**
 * POST /api/ads/google/build
 * -> draft_id + preview
 */
router.post("/google/build", authRequired, isAdmin, async (req, res) => {
  if (isOff()) return res.status(403).json({ error: "ai_mode_off" });
  if (!env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY manquant" });

  try {
    const ai = await runDuuminiAgent("campaign_google", req.body || {});
    const google = ai?.google;
    if (!google?.campaign_name || !google?.ads) {
      return res.status(500).json({ error: "IA n'a pas renvoyé une campagne google valide", raw: ai });
    }

    const info = putDraft("google", google);
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", draft_id: info.id, preview: google });
  } catch (err) {
    return res.status(500).json({ error: "google_build_error", details: err.message });
  }
});

/**
 * GET /api/ads/google/export?draft_id=...
 * -> CSV download
 */
router.get("/google/export", authRequired, isAdmin, async (req, res) => {
  const draft_id = req.query.draft_id;
  const d = getDraft(draft_id);
  if (!d || d.type !== "google") return res.status(404).json({ error: "draft_not_found" });

  const csv = toGoogleCsv(d.payload || {});
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="duumini_google_ads_${draft_id}.csv"`);
  return res.status(200).send(csv);
});

module.exports = router;
