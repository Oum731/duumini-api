const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authRequired, requireRole('ADMIN'), async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'name & slug required' });
  const pool = getPool();
  try {
    const [r] = await pool.query(`INSERT INTO categories (name, slug) VALUES (?,?)`, [name, slug]);
    res.status(201).json({ id: r.insertId, name, slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
