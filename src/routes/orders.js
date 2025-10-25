const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

// List
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

// Create order
router.post('/', authRequired, async (req, res) => {
  const { address, geo_link, items = [] } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items[] required' });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    let total = 0;
    const cleanItems = [];
    for (const it of items) {
      const { product_id, qty } = it || {};
      if (!product_id || !qty) throw new Error('product_id & qty required');

      const [[p]] = await conn.query(`SELECT id, price FROM products WHERE id=?`, [product_id]);
      if (!p) throw new Error('Product not found: ' + product_id);

      cleanItems.push({ product_id: p.id, qty, unit_price: p.price });
      total += Number(p.price) * Number(qty);
    }

    const [r] = await conn.query(
      `INSERT INTO orders (user_id, address, geo_link, total, currency)
       VALUES (?,?,?,?, 'MAD')`,
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

    // Temps réel : informer le user
    const { notifyUser } = require('../services/notify');
    await notifyUser(req.user.id, "ORDER_CREATED", { order_id: orderId, total });

    res.status(201).json({ id: orderId, total });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// Update status (admin ou vendeur propriétaire)
router.put('/:id/status', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ['OPEN','PREPARATION','DELIVERY','DONE','CANCELLED'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const pool = getPool();
  try {
    if (!isAdmin(req.user)) {
      // Vérifier ownership vendeur
      const [[row]] = await pool.query(`
        SELECT s.owner_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        JOIN shops s ON s.id = p.shop_id
        WHERE o.id = ?
        LIMIT 1
      `, [id]);

      if (!row) return res.status(404).json({ error: "Not found" });
      if (!(isVendor(req.user) && String(row.owner_id) === String(req.user.id))) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    await pool.query(`UPDATE orders SET status=? WHERE id=?`, [status, id]);

    // push temps réel à l’acheteur
    const [[order]] = await pool.query(`SELECT user_id FROM orders WHERE id=?`, [id]);
    if (order) {
      const { notifyUser } = require('../services/notify');
      await notifyUser(order.user_id, "ORDER_STATUS", { order_id: id, status });
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
