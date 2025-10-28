const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired } = require('../middlewares/auth');

const router = Router();

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

module.exports = router;
