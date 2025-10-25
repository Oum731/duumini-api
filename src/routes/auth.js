const { Router } = require('express');
const { getPool } = require('../lib/db');
const bcrypt = require('bcryptjs');
const { signAccess, signRefresh, verifyRefresh } = require('../utils/jwt');

const router = Router();

router.post('/register', async (req, res) => {
  const { phone, password, role } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const pool = getPool();
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (phone, password, role) VALUES (?,?,?)`,
      [phone, hash, role && ['MEMBER','VENDEUR','LIVREUR','ADMIN'].includes(role) ? role : 'MEMBER']
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("Duplicate")) return res.status(409).json({ error: "Phone already exists" });
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT id, phone, password, role, first_name, last_name, avatar FROM users WHERE phone=? LIMIT 1`, [phone]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const access_token = signAccess({ id: user.id, phone: user.phone, role: user.role });
    const refresh_token = signRefresh({ id: user.id, role: user.role });
    res.json({
      access_token, refresh_token,
      user: { id: user.id, phone: user.phone, role: user.role, first_name: user.first_name, last_name: user.last_name, avatar: user.avatar }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
  try {
    const p = verifyRefresh(refresh_token);
    const access_token = signAccess({ id: p.id, role: p.role });
    return res.json({ access_token });
  } catch {
    return res.status(401).json({ error: 'invalid refresh_token' });
  }
});

router.post('/logout', (_req, res) => res.json({ ok: true })); // stateless

module.exports = router;
