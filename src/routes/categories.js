// src/routes/categories.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

/**
 * Petit helper pour slugifier un nom
 */
function slugify(str) {
  return String(str || '')
    .normalize('NFD')                       // enlève les accents
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')           // remplace les blocs non alphanum par -
    .replace(/^-+|-+$/g, '')               // trim des -
    || Date.now().toString(36);
}

/**
 * GET /api/categories
 */
router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM categories`);
    const [rows] = await pool.query(
      `SELECT * FROM categories ORDER BY name ASC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/categories
 * Body attendu:
 *  - name: string (obligatoire)
 *  - slug?: string (optionnel → généré automatiquement à partir du name)
 */
router.post('/', authRequired, requireRole('ADMIN'), async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const pool = getPool();
  try {
    // Slug de base (fourni ou généré à partir du name)
    const baseSlug = slug && String(slug).trim() ? String(slug).trim() : slugify(name);

    // On garantit l'unicité du slug
    let finalSlug = baseSlug;
    let suffix = 1;
    // Boucle tant qu'un enregistrement existe avec ce slug
    // (protection simple contre les doublons)
    // ATTENTION: cas rare, mais suffisant ici.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM categories WHERE slug=?`,
        [finalSlug]
      );
      if (count === 0) break;
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    const [r] = await pool.query(
      `INSERT INTO categories (name, slug) VALUES (?,?)`,
      [name, finalSlug]
    );

    res.status(201).json({ id: r.insertId, name, slug: finalSlug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
