// api/auth.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const bcrypt = require('bcryptjs');
const { signAccess, signRefresh, verifyRefresh } = require('../utils/jwt');

const router = Router();

/* ===== Helper ville: code → libellé ===== */
function normalizeVille(ville) {
  if (!ville) return null;
  const code = String(ville).trim().toUpperCase();
  if (code === 'CASABLANCA') return 'Casablanca';
  if (code === 'MARRAKECH')  return 'Marrakech';
  return ville;
}

/**
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  const { phone, password, first_name, last_name, avatar, ville, commune, quartier, sexe } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const _sexe = ['M','F'].includes(sexe) ? sexe : null;
  const _ville = normalizeVille(ville);

  const pool = getPool();
  try {
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query(
      `
      INSERT INTO users
        (phone, password, role, first_name, last_name, avatar, ville, commune, quartier, sexe)
      VALUES
        (?,?,?,?,?,?,?,?,?,?)
      `,
      [
        String(phone).trim(),
        hash,
        'MEMBER',
        first_name || null,
        last_name || null,
        avatar || null,
        _ville || null,
        commune || null,
        quartier || null,
        _sexe
      ]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg.includes('Duplicate')) {
      return res.status(409).json({ error: 'Phone already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, phone, password, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE phone=? LIMIT 1`,
      [String(phone).trim()]
    );
    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const access_token = signAccess({ id: user.id, phone: user.phone, role: user.role });
    const refresh_token = signRefresh({ id: user.id, role: user.role });

    res.json({
      access_token,
      refresh_token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        ville: user.ville,
        commune: user.commune,
        quartier: user.quartier,
        sexe: user.sexe
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/refresh
 * ⚠️ Reprend le rôle ACTUEL en base avant de signer un nouveau access_token.
 */
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  try {
    const payload = verifyRefresh(refresh_token); // { id, role } (role potentiellement obsolète)
    const pool = getPool();

    // 🔎 Relire le rôle courant en base
    const [rows] = await pool.query(
      `SELECT id, role FROM users WHERE id=? LIMIT 1`,
      [payload.id]
    );
    const dbUser = rows && rows[0];
    if (!dbUser) return res.status(401).json({ error: 'invalid refresh_token' });

    const access_token = signAccess({ id: dbUser.id, role: dbUser.role });
    return res.json({ access_token });
  } catch {
    return res.status(401).json({ error: 'invalid refresh_token' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (_req, res) => res.json({ ok: true }));

module.exports = router;
