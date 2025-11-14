// routes/devices.js
const { Router } = require("express");
const { authRequired } = require("../middlewares/auth");
const { getPool } = require("../lib/db");

const router = Router();

/**
 * POST /api/devices
 * Body: { push_token, provider?="pushy" }
 * Enregistre (ou met à jour) un device pour l'utilisateur connecté
 */
router.post("/", authRequired, async (req, res) => {
  const { push_token, provider = "pushy" } = req.body || {};
  if (!push_token) {
    return res.status(400).json({ error: "push_token required" });
  }
  await getPool().query(
    `INSERT INTO user_devices (user_id, push_token, provider)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider)`,
    [req.user.id, push_token, provider]
  );
  res.json({ ok: true });
});

/**
 * POST /api/devices/unregister
 * Body: { push_token?, provider?="pushy" }
 * - si push_token est fourni : supprime précisément ce token
 * - sinon : supprime tous les devices de ce provider pour l'utilisateur
 */
router.post("/unregister", authRequired, async (req, res) => {
  const { push_token, provider = "pushy" } = req.body || {};
  const pool = getPool();

  if (push_token) {
    await pool.query(
      "DELETE FROM user_devices WHERE user_id=? AND push_token=? AND provider=?",
      [req.user.id, push_token, provider]
    );
  } else {
    await pool.query(
      "DELETE FROM user_devices WHERE user_id=? AND provider=?",
      [req.user.id, provider]
    );
  }

  res.json({ ok: true });
});

module.exports = router;
