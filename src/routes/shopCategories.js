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
  return (
    String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || Date.now().toString(36)
  );
}

/**
 * GET /api/shop-categories
 * Liste paginée
 * Query: page, pageSize
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
 * GET /api/shop-categories/:id
 * Détail d'une catégorie
 */
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT * FROM shop_categories WHERE id=?`,
      [id]
    );
    const cat = rows[0];
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    res.json(cat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/shop-categories
 * Body:
 *  - name: string (obligatoire)
 *  - slug?: string (optionnel, généré à partir du name si absent)
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

/**
 * PUT /api/shop-categories/:id
 * Body:
 *  - name: string (obligatoire)
 *  - slug?: string (optionnel, recalculé si absent)
 */
router.put('/:id', authRequired, requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { name, slug } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const pool = getPool();
  try {
    // Vérifier l'existence
    const [rows] = await pool.query(
      `SELECT * FROM shop_categories WHERE id=?`,
      [id]
    );
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const baseSlug = slug && String(slug).trim() ? String(slug).trim() : slugify(name);

    let finalSlug = baseSlug;
    let suffix = 1;
    // On vérifie l'unicité du slug en excluant l'id courant
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM shop_categories WHERE slug=? AND id<>?`,
        [finalSlug, id]
      );
      if (count === 0) break;
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    await pool.query(
      `UPDATE shop_categories SET name=?, slug=? WHERE id=?`,
      [name, finalSlug, id]
    );

    res.json({ id, name, slug: finalSlug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/shop-categories/:id
 */
router.delete('/:id', authRequired, requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();
  try {
    // Optionnel: vérifier que la catégorie n'est pas utilisée par des shops
    // (si tu as une contrainte FK, un shop lié fera échouer le DELETE)
    await pool.query(`DELETE FROM shop_categories WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    // Si tu veux gérer le cas "catégorie utilisée", tu peux tester le code d'erreur MySQL ici
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
