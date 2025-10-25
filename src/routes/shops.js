const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM shops`);
    const [rows] = await pool.query(
      `SELECT s.*, sc.name as category_name, sc.slug as category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/mine', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM shops WHERE owner_id=? ORDER BY created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const { name, slug, category_id, address, city, country, lat, lng, logo, cover } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'name & slug required' });

  const owner_id = req.user.id;
  const pool = getPool();
  try {
    const [r] = await pool.query(
      `INSERT INTO shops (owner_id, name, slug, category_id, address, city, country, lat, lng, logo, cover)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [owner_id, name, slug, category_id || null, address || null, city || null, country || 'Maroc',
       lat || null, lng || null, logo || null, cover || null]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, slug, category_id, address, city, country, lat, lng, logo, cover } = req.body || {};
  const pool = getPool();

  try {
    const [rows] = await pool.query(`SELECT owner_id FROM shops WHERE id=?`, [id]);
    const shop = rows[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    if (!isAdmin(req.user) && !(isVendor(req.user) && shop.owner_id === req.user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query(
      `UPDATE shops SET name=?, slug=?, category_id=?, address=?, city=?, country=?, lat=?, lng=?, logo=?, cover=? WHERE id=?`,
      [name, slug, category_id || null, address || null, city || null, country || 'Maroc',
       lat || null, lng || null, logo || null, cover || null, id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
