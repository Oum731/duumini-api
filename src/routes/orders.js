// routes/orders.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

/* =========================
 * Helpers
 * =======================*/

/** Parse JSON sans throw */
function safeParseJSON(maybe) {
  if (!maybe) return null;
  if (typeof maybe === 'object') return maybe;
  try { return JSON.parse(maybe); } catch { return null; }
}

/** Normalise l'objet adresse reçu du front en un objet stockable (JSON).
 * input: { ville, commune, quartier|null, gps:{lat,lng}|null }
 */
function buildAddressObj(input = {}) {
  const ville = input?.ville ?? null;
  const commune = input?.commune ?? null;
  const quartier = input?.quartier ?? null;
  const gps = input?.gps && typeof input.gps === 'object'
    ? { lat: Number(input.gps.lat), lng: Number(input.gps.lng) }
    : null;

  return {
    city: ville,
    commune,
    district: quartier,
    gps,
  };
}

/** Construit un lien Google Maps à partir d'un gps {lat,lng} */
function buildGeoLink(gps) {
  if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') return null;
  return `https://maps.google.com/?q=${gps.lat},${gps.lng}`;
}

/** Normalisation téléphone (+212...) */
function normPhone(p) {
  const raw = String(p || '').replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+' + raw.slice(2);
  if (/^0\d{9,}$/.test(raw)) return '+212' + raw.slice(1);
  return raw;
}

/** Construit un objet contact à partir d'un user row */
function buildContactFromUser(u) {
  if (!u) return { first_name: null, last_name: null, phone: null };
  return {
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    phone: normPhone(u.phone) || null,
  };
}

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
 * → ajoute toujours un champ contact (fallback users)
 * =======================*/
router.get('/', authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    if (isAdmin(req.user)) {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders`);
      const [rows] = await pool.query(
        `
        SELECT o.*, u.first_name AS u_first, u.last_name AS u_last, u.phone AS u_phone
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [limit, offset]
      );

      const items = rows.map(r => {
        const address = safeParseJSON(r.address);
        // Si un jour tu ajoutes o.contact JSON, tu peux le parser ici:
        const contactFromOrder = safeParseJSON(r.contact); // souvent null/absent
        const contact =
          (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        return {
          ...r,
          address,
          contact,
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    } else {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM orders WHERE user_id=?`,
        [req.user.id]
      );
      const [rows] = await pool.query(
        `
        SELECT o.*, u.first_name AS u_first, u.last_name AS u_last, u.phone AS u_phone
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.user_id=?
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [req.user.id, limit, offset]
      );

      const items = rows.map(r => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        return {
          ...r,
          address,
          contact,
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
 * Create order
 * Accepte le payload du Checkout (contact/address/delivery/items/totals/payment).
 * ⚠️ Aucun changement de schéma requis. On ne stocke pas contact (fallback users en lecture).
 * =======================*/
router.post('/', authRequired, async (req, res) => {
  const {
    // contact ignoré au stockage (fallback users)
    address = {},
    delivery = {},
    items = [],
    totals = {},
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) Normaliser adresse et geo_link
    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    // 2) Recalcule total articles côté serveur (ignore price du front)
    let itemsAmount = 0;
    const cleanItems = [];

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = Number(it?.qty);
      if (!product_id || !qty) throw new Error('product_id & qty required');

      const [[p]] = await conn.query(
        `SELECT id, price FROM products WHERE id=?`,
        [product_id]
      );
      if (!p) throw new Error('Product not found: ' + product_id);

      const unit_price = Number(p.price);
      cleanItems.push({ product_id: p.id, qty, unit_price });
      itemsAmount += unit_price * qty;
    }

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || 'MAD').toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    // 3) INSERT order — uniquement colonnes existantes
    const [r] = await conn.query(
      `
      INSERT INTO orders (user_id, status, address, geo_link, total, currency, created_at, updated_at)
      VALUES (?, 'OPEN', ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        req.user.id,
        JSON.stringify(addressObj), // JSON/TEXT
        geoLink,
        orderTotal,
        currency,
      ]
    );
    const orderId = r.insertId;

    // 4) INSERT order_items (snapshots des prix)
    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    await conn.commit();

    // 5) Notification temps réel (best effort)
    try {
      const { notifyUser } = require('../services/notify');
      await notifyUser(req.user.id, 'ORDER_CREATED', { order_id: orderId, total: orderTotal });
    } catch {}

    res.status(201).json({ id: orderId, status: 'OPEN', total: orderTotal, currency });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Get one order (detail + items) avec permissions
 * → ajoute toujours un champ contact (fallback users)
 * =======================*/
router.get('/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    const o = result.order;
    const addr = safeParseJSON(o.address);

    // Charger user pour fallback contact
    const [[u]] = await conn.query(
      'SELECT first_name, last_name, phone FROM users WHERE id=? LIMIT 1',
      [o.user_id]
    );
    const contactFromOrder = safeParseJSON(o.contact); // si jamais tu l’as un jour
    const contact =
      (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
        ? contactFromOrder
        : buildContactFromUser(u);

    res.json({
      ...o,
      contact,                // <<<<<< IMPORTANT
      address: addr,
      items: result.items,
      geo_link: o.geo_link || buildGeoLink(addr?.gps) || null,
    });
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

    await pool.query(`UPDATE orders SET status=?, updated_at=NOW() WHERE id=?`, [status, id]);

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
    const blocked = ['DONE', 'CANCELLED'].includes(order.status || '');
    if (blocked && !isAdmin(req.user)) {
      return res.status(409).json({ error: 'Cannot cancel at this stage' });
    }

    await conn.query(`UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE id=?`, [id]);

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
