// src/routes/ai.js
const { Router } = require("express");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { runDuuminiAgent } = require("../ai/duuminiAgent");
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

// ✅ POST /api/ai/duumini (ADMIN)
router.post("/duumini", authRequired, isAdmin, async (req, res, next) => {
  if (!ensureAiOn(res)) return;
  try {
    const { taskType, payload } = req.body || {};
    const out = await runDuuminiAgent(taskType, payload || {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// POST /api/ai/weekly-plan (ADMIN)
router.post("/weekly-plan", authRequired, isAdmin, async (req, res) => {
  if (!ensureAiOn(res)) return;
  try {
    const data = await runDuuminiAgent("weekly_plan", req.body || {});
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", data });
  } catch (err) {
    return res.status(500).json({
      error: "weekly_plan_error",
      details: err?.message || String(err),
    });
  }
});

// POST /api/ai/social-posts (ADMIN)
router.post("/social-posts", authRequired, isAdmin, async (req, res) => {
  if (!ensureAiOn(res)) return;
  try {
    const data = await runDuuminiAgent("social_posts", req.body || {});
    return res.json({ ok: true, mode: env.DUUMINI_AI_MODE || "SAFE", data });
  } catch (err) {
    return res.status(500).json({
      error: "social_posts_error",
      details: err?.message || String(err),
    });
  }
});

// POST /api/ai/whatsapp-reply (ADMIN)
router.post("/whatsapp-reply", authRequired, isAdmin, async (req, res) => {
  if (!ensureAiOn(res)) return;

  const { message, context, language } = req.body || {};
  if (!message) return res.status(400).json({ error: "message requis" });

  try {
    const text = await runDuuminiAgent("whatsapp_reply", {
      message,
      context,
      language,
    });
    return res.json({
      ok: true,
      mode: env.DUUMINI_AI_MODE || "SAFE",
      data: { text },
    });
  } catch (err) {
    return res.status(500).json({
      error: "whatsapp_reply_error",
      details: err?.message || String(err),
    });
  }
});

module.exports = router;
