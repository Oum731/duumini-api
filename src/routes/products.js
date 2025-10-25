const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

function normalizeChannel(channel) {
  const c = String(channel || "").toLowerCase();
  if (c === "african-food") return "african-food";
  if (c === "african-market") return "african-market";
  return null;
}

async function listProducts(pool, { limit, offset, channel }) {
  let where = "1=1";
  const params = [];

  if (channel === "african-food") {
    where = "p.sub_category = 'food'";
  } else if (channel === "african-market") {
    where = "(p.sub_category IS NULL OR p.sub_category <> 'food')";
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM products p WHERE ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT p.*,
            (SELECT url FROM product_images pi WHERE pi.product_id=p.id ORDER BY sort_order ASC, id ASC LIMIT 1) AS cover
     FROM products p
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { rows, total };
}

router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const channel = normalizeChannel(req.query.channel);
  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, { limit, offset, channel });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aliases explicites
router.get('/african-food', async (req, res) => {
  req.query.channel = "african-food";
  return router.handle(req, res);
});
router.get('/african-market', async (req, res) => {
  req.query.channel = "african-market";
  return router.handle(req, res);
});

// Get by id
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: 'Not found' });

    const [images] = await pool.query(
      `SELECT id, url, sort_order FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    res.json({ ...product, images });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create
router.post('/', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const {
    shop_id, category_id,
    name, slug, price, currency,
    description, stock,
    is_featured, promo_eligible,
    sub_category, images = []
  } = req.body || {};

  if (!shop_id || !name || !price) return res.status(400).json({ error: 'shop_id, name, price required' });

  const sub = ['product','food','other'].includes(String(sub_category)) ? sub_category : 'product';
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [[shop]] = await conn.query(`SELECT owner_id FROM shops WHERE id=?`, [shop_id]);
    if (!shop) { conn.release(); return res.status(400).json({ error: 'Invalid shop_id' }); }
    if (isVendor(req.user) && String(shop.owner_id) !== String(req.user.id)) {
      conn.release(); return res.status(403).json({ error: 'Forbidden: not your shop' });
    }

    // slug unique si non fourni (coté Node)
    const makeSlug = () => (slug && String(slug).trim()) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`.toLowerCase();

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO products (shop_id, category_id, name, slug, price, currency, description, stock, is_featured, promo_eligible, sub_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        shop_id,
        category_id || null,
        name,
        makeSlug(),
        price,
        currency || 'MAD',
        description || null,
        stock ?? 0,
        !!is_featured ? 1 : 0,
        !!promo_eligible ? 1 : 0,
        sub
      ]
    );
    const productId = r.insertId;

    for (let i = 0; i < images.length; i++) {
      await conn.query(
        `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
        [productId, images[i], i]
      );
    }

    await conn.commit();

    // Événement temps réel (optionnel): nouveau produit
    const { getIO, emitToShops } = require('../ws');
    const io = getIO();
    if (io) emitToShops([shop_id], "product:created", { product_id: productId });

    // canal front: African Food si sub=food, sinon African Market
    const channel = sub === 'food' ? 'african-food' : 'african-market';
    res.status(201).json({ id: productId, channel });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// Update
router.put('/:id', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const {
    name, price, currency, description, stock,
    is_featured, promo_eligible, sub_category, category_id
  } = req.body || {};
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [[prod]] = await conn.query(
      `SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`, [id]
    );
    if (!prod) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
      conn.release(); return res.status(403).json({ error: 'Forbidden' });
    }

    const sub = sub_category && ['product','food','other'].includes(sub_category) ? sub_category : null;

    await conn.query(
      `UPDATE products SET
         name = COALESCE(?, name),
         price = COALESCE(?, price),
         currency = COALESCE(?, currency),
         description = COALESCE(?, description),
         stock = COALESCE(?, stock),
         is_featured = COALESCE(?, is_featured),
         promo_eligible = COALESCE(?, promo_eligible),
         sub_category = COALESCE(?, sub_category),
         category_id = COALESCE(?, category_id)
       WHERE id=?`,
      [
        name ?? null,
        price ?? null,
        currency ?? null,
        description ?? null,
        stock ?? null,
        is_featured === undefined ? null : (is_featured ? 1 : 0),
        promo_eligible === undefined ? null : (promo_eligible ? 1 : 0),
        sub,
        category_id ?? null,
        id
      ]
    );

    // Événement temps réel
    const { getIO } = require('../ws');
    const io = getIO();
    if (io) io.broadcastToUser(prod.owner_id, "product:updated", { product_id: id });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// Replace images
router.put('/:id/images', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const { images = [] } = req.body || {};
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [[prod]] = await conn.query(`SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`, [id]);
    if (!prod) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
      conn.release(); return res.status(403).json({ error: 'Forbidden' });
    }

    await conn.beginTransaction();
    await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
    for (let i = 0; i < images.length; i++) {
      await conn.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`, [id, images[i], i]);
    }
    await conn.commit();

    res.json({ ok: true });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
