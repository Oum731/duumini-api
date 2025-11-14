// src/routes/shop_categories.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { getPagination, buildPageInfo } = require('../utils/pagination');
const { authRequired, requireRole } = require('../middlewares/auth');

const router = Router();

/**
 * Helper slug identique pour les catégories de boutiques
 */
function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || Date.now().toString(36);
}

/**
 * GET /api/shop-categories
 */
router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM shop_categories`);
    const [rows] = await pool.query(
      `SELECT * FROM shop_categories ORDER BY name ASC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/shop-categories
 * Body:
 *  - name: string (obligatoire)
 *  - slug?: string (optionnel, généré à partir du name)
 */
router.post('/', authRequired, requireRole('ADMIN'), async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const pool = getPool();
  try {
    const baseSlug = slug && String(slug).trim() ? String(slug).trim() : slugify(name);

    let finalSlug = baseSlug;
    let suffix = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM shop_categories WHERE slug=?`,
        [finalSlug]
      );
      if (count === 0) break;
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    const [r] = await pool.query(
      `INSERT INTO shop_categories (name, slug) VALUES (?,?)`,
      [name, finalSlug]
    );

    res.status(201).json({ id: r.insertId, name, slug: finalSlug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
