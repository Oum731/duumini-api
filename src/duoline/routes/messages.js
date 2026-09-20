const { Router } = require("express");
const { Op } = require("sequelize");
const { Message, User, messageInclude, resolveReplyId } = require("../models");
const { requireAuth } = require("../middleware/auth");

const messagesRouter = Router();

// Historique paginé (le plus récent en dernier), conversation unique à 2.
messagesRouter.get("/", requireAuth, async (req, res) => {
  // Pagination par id (croissant avec le temps, sans ambiguïté même si deux
  // messages partagent la même milliseconde) : les N messages juste avant
  // beforeId, ou les N plus récents si absent.
  const beforeId = Number(req.query.beforeId) || null;
  const limit = Math.min(Number(req.query.limit) || 40, 100);

  const messages = await Message.findAll({
    where: beforeId ? { id: { [Op.lt]: beforeId } } : {},
    include: messageInclude(),
    order: [["id", "DESC"]],
    limit,
  });

  res.json(messages.reverse());
});

// Recherche texte sur tout l'historique (l'écran de chat ne garde que les
// ~30 derniers messages en mémoire, insuffisant pour retrouver un vieux
// message).
messagesRouter.get("/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  const messages = await Message.findAll({
    where: { type: "text", content: { [Op.like]: `%${q}%` } },
    include: messageInclude(),
    order: [["createdAt", "DESC"]],
    limit: 50,
  });

  res.json(messages.reverse());
});

module.exports = { messagesRouter };
