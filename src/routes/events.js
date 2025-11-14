// src/routes/events.js
const { Router } = require("express");
const { authRequired } = require("../middlewares/auth");

const router = Router();

/**
 * GET /api/events/stream
 * Flux SSE protégé (EventSource côté frontend).
 *
 * Pour l'instant :
 *  - garde la connexion ouverte
 *  - envoie un petit "PING" périodique
 * 
 * Ton frontend (subscribeSSE) n'écoutera que ORDER_CREATED / ORDER_STATUS donc
 * ces PING sont ignorés, c'est juste pour garder le lien en vie.
 */
router.get("/stream", authRequired, (req, res) => {
  // En-têtes SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // pour certains reverse proxy
  res.flushHeaders && res.flushHeaders();

  const userId = req.user.id;
  console.log("[SSE] client connecté user:", userId);

  // Petit événement initial (optionnel)
  const initial = { type: "CONNECTED", payload: { ts: Date.now() } };
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Heartbeat toutes les 30s pour garder la connexion ouverte
  const interval = setInterval(() => {
    const ping = { type: "PING", payload: { ts: Date.now() } };
    res.write(`data: ${JSON.stringify(ping)}\n\n`);
  }, 30000);

  // Quand le client coupe la connexion
  req.on("close", () => {
    console.log("[SSE] client déconnecté user:", userId);
    clearInterval(interval);
    res.end();
  });
});

module.exports = router;
