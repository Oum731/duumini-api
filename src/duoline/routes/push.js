const { Router } = require("express");
const { env } = require("../config/env");
const { PushSubscription } = require("../models");
const { requireAuth } = require("../middleware/auth");

const pushRouter = Router();

pushRouter.get("/public-key", requireAuth, (req, res) => {
  res.json({ publicKey: env.vapid.publicKey });
});

pushRouter.post("/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Abonnement invalide" });
  }

  await PushSubscription.upsert({
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userId: req.user.id,
  });

  res.status(201).json({ ok: true });
});

pushRouter.post("/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await PushSubscription.destroy({ where: { endpoint } });
  res.json({ ok: true });
});

module.exports = { pushRouter };
