// Module DuoLine (app privée à 2, chat + appels WebRTC) — isolé du reste de
// duumini-api : namespace socket.io séparé, base MySQL séparée, JWT séparé.
// Monté par server.js sous /duoline.
const { Router } = require("express");
const express = require("express");

const { initDb } = require("./models");
const { authRouter } = require("./routes/auth");
const { messagesRouter } = require("./routes/messages");
const { createMediaRouter } = require("./routes/media");
const { pushRouter } = require("./routes/push");
const { turnRouter } = require("./routes/turn");
const { partnerRouter } = require("./routes/partner");
const { registerSockets } = require("./sockets");
const { uploadsDir } = require("./routes/media");

// Synchrone : construit et retourne le router immédiatement (nécessaire pour
// être monté avec app.use() avant app.use(notFound)). La connexion DB se
// fait en tâche de fond — les requêtes échoueront proprement le temps
// qu'elle s'établisse, sans bloquer le démarrage du reste de l'API.
function createDuolineModule(io) {
  const nsp = io.of("/duoline");
  registerSockets(nsp);

  initDb().then(
    () => console.log("[duoline] DB connectée"),
    (err) => console.error("[duoline] échec connexion DB:", err.message)
  );

  const router = Router();
  router.use("/uploads", express.static(uploadsDir));
  router.get("/health", (req, res) => res.json({ ok: true, module: "duoline" }));

  // Sous /api pour matcher exactement les chemins déjà en dur dans le
  // frontend DuoLine (/api/auth/login, /api/messages, ...) — seul
  // VITE_API_BASE change (pointe vers .../duoline), zéro autre diff frontend.
  router.use("/api/auth", authRouter);
  router.use("/api/messages", messagesRouter);
  router.use("/api/media", createMediaRouter(nsp));
  router.use("/api/push", pushRouter);
  router.use("/api/ice-servers", turnRouter);
  router.use("/api/partner", partnerRouter);

  return router;
}

module.exports = { createDuolineModule };
