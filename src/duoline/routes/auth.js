const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { User } = require("../models");
const { requireAuth } = require("../middleware/auth");

const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const user = await User.findOne({ where: { email } });
  if (!user) return res.status(401).json({ error: "Identifiants invalides" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn || "30d",
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
});

module.exports = { authRouter };
