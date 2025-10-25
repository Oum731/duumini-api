const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

/* =========================
 * Helpers
 * =======================*/

/**
 * Charge une commande + vérifie les permissions en fonction de req.user.
 * Règles:
 * - ADMIN: accès total
 * - VENDEUR: doit être propriétaire d'au moins un shop lié à la commande
 * - CLIENT: doit être l'acheteur (orders.user_id)
 * Retour:
 *   { status: 200, order, items }  ou  { status, error }
 */
async function getOrderWithPerm(conn, id, user) {
  const [[order]] = await conn.query(`SELECT * FROM orders WHERE id=?`, [id]);
  if (!order) return { status: 404, error: 'Not found' };

  if (!isAdmin(user)) {
    if (isVendor(user)) {
      const [[own]] = await conn.query(
        `
        SELECT 1
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        JOIN shops s    ON s.id = p.shop_id
        WHERE oi.order_id = ? AND s.owner_id = ?
        LIMIT 1
        `,
        [id, user.id]
      );
      if (!own) return { status: 403, error: 'Forbidden' };
    } else {
      if (String(order.user_id) !== String(user.id)) {
        return { status: 403, error: 'Forbidden' };
      }
    }
  }

  const [items] = await conn.query(
    `
    SELECT oi.*, p.name AS product_name
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id=?
    ORDER BY oi.id ASC
    `,
    [id]
  );

  return { status: 200, order, items };
}

/* =========================
 * List (admin : tout / client : ses commandes)
 * =======================*/
router.get('/', authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    if (isAdmin(req.user)) {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders`);
      const [rows] = await pool.query(
        `SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      return res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
    } else {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM orders WHERE user_id=?`,
        [req.user.id]
      );
      const [rows] = await pool.query(
        `SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [req.user.id, limit, offset]
      );
      return res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
 * Create order
 * Body: { address?, geo_link?, items: [{product_id, qty}] }
 * =======================*/
router.post('/', authRequired, async (req, res) => {
  const { address, geo_link, items = [] } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    let total = 0;
    const cleanItems = [];

    for (const it of items) {
      const { product_id, qty } = it || {};
      if (!product_id || !qty) throw new Error('product_id & qty required');

      const [[p]] = await conn.query(
        `SELECT id, price FROM products WHERE id=?`,
        [product_id]
      );
      if (!p) throw new Error('Product not found: ' + product_id);

      cleanItems.push({ product_id: p.id, qty: Number(qty), unit_price: Number(p.price) });
      total += Number(p.price) * Number(qty);
    }

    const [r] = await conn.query(
      `INSERT INTO orders (user_id, address, geo_link, total, currency, status)
       VALUES (?,?,?,?, 'MAD', 'OPEN')`,
      [req.user.id, address || null, geo_link || null, total]
    );
    const orderId = r.insertId;

    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    await conn.commit();

    // Temps réel : informer l’acheteur
    try {
      const { notifyUser } = require('../services/notify');
      await notifyUser(req.user.id, 'ORDER_CREATED', { order_id: orderId, total });
    } catch {}

    res.status(201).json({ id: orderId, total });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Get one order (detail + items) avec permissions
 * =======================*/
router.get('/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    // Normaliser l'adresse si stockée en JSON string ailleurs
    let o = result.order;
    if (o.shipping_address && typeof o.shipping_address === 'string') {
      try { o.shipping_address = JSON.parse(o.shipping_address); } catch {}
    }

    res.json({ ...o, items: result.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

/* =========================
 * Update status (admin ou vendeur propriétaire)
 * Body: { status: 'OPEN'|'PREPARATION'|'DELIVERY'|'DONE'|'CANCELLED' }
 * =======================*/
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
      // Vérifie ownership vendeur sur au moins un item
      const [[row]] = await pool.query(
        `
        SELECT s.owner_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        JOIN shops s ON s.id = p.shop_id
        WHERE o.id = ?
        LIMIT 1
        `,
        [id]
      );

      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!(isVendor(req.user) && String(row.owner_id) === String(req.user.id))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(`UPDATE orders SET status=? WHERE id=?`, [status, id]);

    // Push temps réel à l’acheteur
    const [[order]] = await pool.query(`SELECT user_id FROM orders WHERE id=?`, [id]);
    if (order) {
      try {
        const { notifyUser } = require('../services/notify');
        await notifyUser(order.user_id, 'ORDER_STATUS', { order_id: id, status });
      } catch {}
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
 * Annulation par l’acheteur (ou admin)
 * =======================*/
router.post('/:id/cancel', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    const order = result.order;
    // On empêche l'annulation si DONE/CANCELLED (sauf admin)
    const blocked = ['DONE', 'CANCELLED'].includes(order.status || '');
    if (blocked && !isAdmin(req.user)) {
      return res.status(409).json({ error: 'Cannot cancel at this stage' });
    }

    await conn.query(`UPDATE orders SET status='CANCELLED' WHERE id=?`, [id]);

    // Notif acheteur
    try {
      const { notifyUser } = require('../services/notify');
      await notifyUser(order.user_id, 'ORDER_STATUS', { order_id: id, status: 'CANCELLED' });
    } catch {}

    res.json({ ok: true, status: 'CANCELLED' });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
