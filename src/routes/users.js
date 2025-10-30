// users.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired } = require('../middlewares');
const bcrypt = require('bcryptjs');

const router = Router();

/* ===== Middleware admin local ===== */
function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/**
 * GET /api/user/me
 * Retourne le profil complet.
 */
router.get('/me', authRequired, async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE id=?`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/user/me
 * Met à jour des champs autorisés: first_name, last_name, avatar, ville, commune, quartier, sexe (+ optionnellement phone).
 * - contrôle d'unicité sur phone si fourni
 * - normalisation sexe (M/F)
 */
router.put('/me', authRequired, async (req, res) => {
  const { first_name, last_name, avatar, ville, commune, quartier, sexe, phone } = req.body || {};
  const pool = getPool();

  // whitelisting + normalisation
  const fields = [];
  const values = [];

  if (typeof first_name !== 'undefined') { fields.push('first_name=?'); values.push(first_name || null); }
  if (typeof last_name  !== 'undefined') { fields.push('last_name=?');  values.push(last_name || null); }
  if (typeof avatar     !== 'undefined') { fields.push('avatar=?');     values.push(avatar || null); }
  if (typeof ville      !== 'undefined') { fields.push('ville=?');      values.push(ville || null); }
  if (typeof commune    !== 'undefined') { fields.push('commune=?');    values.push(commune || null); }
  if (typeof quartier   !== 'undefined') { fields.push('quartier=?');   values.push(quartier || null); }
  if (typeof sexe       !== 'undefined') {
    const _sexe = ['M','F'].includes(sexe) ? sexe : null;
    fields.push('sexe=?'); values.push(_sexe);
  }
  if (typeof phone      !== 'undefined') {
    fields.push('phone=?'); values.push(String(phone).trim());
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  try {
    // Si on souhaite changer de téléphone -> vérifier l'unicité
    if (typeof phone !== 'undefined') {
      const [dups] = await pool.query(
        'SELECT id FROM users WHERE phone=? AND id<>? LIMIT 1',
        [String(phone).trim(), req.user.id]
      );
      if (dups && dups.length) {
        return res.status(409).json({ error: 'Phone already exists' });
      }
    }

    const sql = `UPDATE users SET ${fields.join(', ')} WHERE id=?`;
    await pool.query(sql, [...values, req.user.id]);

    // renvoyer l’objet user mis à jour
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE id=?`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================
 *            🔒 ADMIN
 * ============================ */

/**
 * GET /api/user?page=&pageSize=&q=
 * Liste paginée des utilisateurs (recherche phone/nom/role)
 */
router.get('/', authRequired, adminRequired, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const q = (req.query.q || '').toString().trim();

  const pool = getPool();
  const where = [];
  const params = [];
  if (q) {
    const like = `%${q}%`;
    where.push(`(phone LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR role LIKE ?)`);
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  try {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM users ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `
      SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
      FROM users
      ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );
    res.json({ items: rows, pageInfo: { page, pageSize, total } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/user
 * Création d'un utilisateur (admin) — rôle optionnel, MEMBER par défaut si non fourni.
 * Body: { phone, password, first_name?, last_name?, role? }
 */
router.post('/', authRequired, adminRequired, async (req, res) => {
  const { phone, password, first_name, last_name, role } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone & password required' });

  const ROLES = ['MEMBER','VENDEUR','LIVREUR','ADMIN'];
  const _role = ROLES.includes(role) ? role : 'MEMBER';

  const pool = getPool();
  try {
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query(
      `INSERT INTO users (phone, password, role, first_name, last_name) VALUES (?,?,?,?,?)`,
      [String(phone).trim(), hash, _role, first_name || null, last_name || null]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('Duplicate')) {
      return res.status(409).json({ error: 'Phone already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/user/:id
 * Mise à jour admin de champs de base (peut inclure `role`)
 */
router.put('/:id', authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { phone, first_name, last_name, ville, commune, quartier, sexe, role } = req.body || {};

  const fields = [];
  const values = [];

  if (typeof phone !== 'undefined')      { fields.push('phone=?');      values.push(String(phone).trim()); }
  if (typeof first_name !== 'undefined') { fields.push('first_name=?'); values.push(first_name || null); }
  if (typeof last_name  !== 'undefined') { fields.push('last_name=?');  values.push(last_name || null); }
  if (typeof ville      !== 'undefined') { fields.push('ville=?');      values.push(ville || null); }
  if (typeof commune    !== 'undefined') { fields.push('commune=?');    values.push(commune || null); }
  if (typeof quartier   !== 'undefined') { fields.push('quartier=?');   values.push(quartier || null); }
  if (typeof sexe       !== 'undefined') {
    const _sexe = ['M','F'].includes(sexe) ? sexe : null;
    fields.push('sexe=?'); values.push(_sexe);
  }
  if (typeof role       !== 'undefined') {
    const ROLES = ['MEMBER','VENDEUR','LIVREUR','ADMIN'];
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    fields.push('role=?'); values.push(role);
  }

  if (!fields.length) return res.status(400).json({ error: 'No fields' });

  try {
    const pool = getPool();

    if (typeof phone !== 'undefined') {
      const [dups] = await pool.query(
        'SELECT id FROM users WHERE phone=? AND id<>? LIMIT 1',
        [String(phone).trim(), id]
      );
      if (dups && dups.length) return res.status(409).json({ error: 'Phone already exists' });
    }

    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, [...values, id]);

    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
       FROM users WHERE id=?`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/user/:id/role
 * Changer uniquement le rôle (plus direct pour l’UI si besoin)
 */
router.patch('/:id/role', authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  const ROLES = ['MEMBER','VENDEUR','LIVREUR','ADMIN'];
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const pool = getPool();
  try {
    await pool.query(`UPDATE users SET role=? WHERE id=?`, [role, id]);
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
       FROM users WHERE id=?`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/user/:id
 */
router.delete('/:id', authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pool = getPool();
  try {
    await pool.query(`DELETE FROM users WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
