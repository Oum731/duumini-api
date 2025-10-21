// src/routes/orders.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

// List (admin: tout ; sinon: mes commandes)
router.get('/', authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    if (isAdmin(req.user)) {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders`);
      const [rows] = await pool.query(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
      return res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
    } else {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders WHERE user_id=?`, [req.user.id]);
      const [rows] = await pool.query(`SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`, [req.user.id, limit, offset]);
      return res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create order (member + any role authenticated)
router.post('/', authRequired, async (req, res) => {
  const { address, geo_link, items = [] } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items[] required' });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Validate products, compute total
    let total = 0;
    const cleanItems = [];
    for (const it of items) {
      const { product_id, qty } = it || {};
      if (!product_id || !qty) throw new Error('product_id & qty required for each item');

      const [[p]] = await conn.query(`SELECT id, price FROM products WHERE id=?`, [product_id]);
      if (!p) throw new Error('Product not found: ' + product_id);

      cleanItems.push({ product_id: p.id, qty, unit_price: p.price });
      total += Number(p.price) * Number(qty);
    }

    const [r] = await conn.query(
      `INSERT INTO orders (user_id, address, geo_link, total, currency) VALUES (?,?,?,?, 'MAD')`,
      [req.user.id, address || null, geo_link || null, total]
    );
    const orderId = r.insertId;

    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    await conn.commit();
    res.status(201).json({ id: orderId, total });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// Update status (ADMIN ou VENDEUR du shop du produit ? Ici: ADMIN only pour simplicité)
router.put('/:id/status', authRequired, requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!['OPEN','PREPARATION','DELIVERY','DONE','CANCELLED'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const pool = getPool();
  try {
    await pool.query(`UPDATE orders SET status=? WHERE id=?`, [status, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
