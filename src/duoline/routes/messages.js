const { Router } = require("express");
const { Op } = require("sequelize");
const { Message, User } = require("../models");
const { requireAuth } = require("../middleware/auth");

const messagesRouter = Router();

// Historique paginé (le plus récent en dernier), conversation unique à 2.
messagesRouter.get("/", requireAuth, async (req, res) => {
  const before = req.query.before ? new Date(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const messages = await Message.findAll({
    where: before ? { createdAt: { [Op.lt]: before } } : {},
    include: [{ model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] }],
    order: [["createdAt", "DESC"]],
    limit,
  });

  res.json(messages.reverse());
});

module.exports = { messagesRouter };
