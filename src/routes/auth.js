// src/routes/auth.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = Router();

router.post('/register', async (req, res) => {
  const { phone, password, role } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const pool = getPool();
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query(
      `INSERT INTO users (phone, password, role) VALUES (?,?,?)`,
      [phone, hash, role && ['MEMBER','VENDEUR','LIVREUR','ADMIN'].includes(role) ? role : 'MEMBER']
    );
    res.status(201).json({ id: r.insertId, phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM users WHERE phone=? LIMIT 1`, [phone]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, phone: user.phone, role: user.role, first_name: user.first_name, last_name: user.last_name, avatar: user.avatar } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
