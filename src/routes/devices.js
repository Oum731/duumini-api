const { Router } = require('express');
const { authRequired } = require('../middlewares/auth');
const { getPool } = require('../lib/db');

const router = Router();

router.post('/', authRequired, async (req, res) => {
  const { push_token, provider = "pushy" } = req.body || {};
  if (!push_token) return res.status(400).json({ error: "push_token required" });
  await getPool().query(
    `INSERT INTO user_devices (user_id, push_token, provider)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider)`,
    [req.user.id, push_token, provider]
  );
  res.json({ ok: true });
});

module.exports = router;
