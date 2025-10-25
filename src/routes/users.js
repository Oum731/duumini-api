const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired } = require('../middlewares/auth');

const router = Router();

router.get('/me', authRequired, async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar FROM users WHERE id=?`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
