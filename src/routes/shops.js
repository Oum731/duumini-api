// api/routes/shops.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

/**
 * GET /api/shops
 * Liste paginée des boutiques (publique), avec recherche q optionnelle.
 * Query: page, pageSize, q
 */
router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  const q = (req.query.q || '').toString().trim();

  try {
    // WHERE dynamique pour la recherche
    let where = 'WHERE 1';
    const paramsCount = [];
    if (q) {
      where += ' AND (s.name LIKE ? OR s.city LIKE ?)';
      paramsCount.push(`%${q}%`, `%${q}%`);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM shops s ${where}`,
      paramsCount
    );

    const paramsData = [...paramsCount, limit, offset];

    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
      paramsData
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/shops/mine
 * Boutiques du vendeur / admin connecté.
 */
router.get('/mine', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.owner_id=?
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/shops/:id
 * Détail public d’une boutique.
 */
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.id=?`,
      [id]
    );
    const shop = rows[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/shops
 * Création d’une boutique (VENDEUR ou ADMIN).
 * Body JSON: { name, slug, category_id?, address?, city?, country?, lat?, lng?, logo?, cover? }
 */
router.post('/', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
  const {
    name,
    slug,
    category_id,
    address,
    city,
    country,
    lat,
    lng,
    logo,
    cover
  } = req.body || {};

  if (!name || !slug) {
    return res.status(400).json({ error: 'name & slug required' });
  }

  const owner_id = req.user.id;
  const pool = getPool();

  try {
    const [r] = await pool.query(
      `INSERT INTO shops (owner_id, name, slug, category_id, address, city, country, lat, lng, logo, cover)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        owner_id,
        name,
        slug,
        category_id || null,
        address || null,
        city || null,
        country || 'Maroc',
        lat || null,
        lng || null,
        logo || null,
        cover || null
      ]
    );

    const newId = r.insertId;
    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.id=?`,
      [newId]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/shops/:id
 * Mise à jour d’une boutique (admin ou vendeur propriétaire).
 */
router.put('/:id', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const {
    name,
    slug,
    category_id,
    address,
    city,
    country,
    lat,
    lng,
    logo,
    cover
  } = req.body || {};

  const pool = getPool();

  try {
    // Vérifier l’existence et le propriétaire
    const [rowsOwner] = await pool.query(`SELECT owner_id FROM shops WHERE id=?`, [id]);
    const shop = rowsOwner[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    if (!isAdmin(req.user) && !(isVendor(req.user) && shop.owner_id === req.user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query(
      `UPDATE shops
       SET name=?, slug=?, category_id=?, address=?, city=?, country=?, lat=?, lng=?, logo=?, cover=?
       WHERE id=?`,
      [
        name,
        slug,
        category_id || null,
        address || null,
        city || null,
        country || 'Maroc',
        lat || null,
        lng || null,
        logo || null,
        cover || null,
        id
      ]
    );

    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.id=?`,
      [id]
    );

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/shops/:id
 * Suppression d’une boutique (admin ou vendeur propriétaire).
 */
router.delete('/:id', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();

  try {
    // Vérifier l’existence et le propriétaire
    const [rowsOwner] = await pool.query(`SELECT owner_id FROM shops WHERE id=?`, [id]);
    const shop = rowsOwner[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    if (!isAdmin(req.user) && !(isVendor(req.user) && shop.owner_id === req.user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query(`DELETE FROM shops WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
