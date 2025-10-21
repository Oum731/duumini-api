// src/routes/products.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

const router = Router();

// List
router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM products`);
    const [rows] = await pool.query(
      `SELECT p.*,
              (SELECT url FROM product_images pi WHERE pi.product_id=p.id ORDER BY sort_order ASC, id ASC LIMIT 1) AS cover
       FROM products p
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get by id
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: 'Not found' });

    const [images] = await pool.query(`SELECT id, url, sort_order FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`, [id]);
    res.json({ ...product, images });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create (VENDEUR ou ADMIN)
router.post('/', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const {
    shop_id, category_id,
    name, slug, price, currency,
    description, stock,
    is_featured, promo_eligible,
    sub_category, images = []
  } = req.body || {};

  if (!shop_id || !name || !price) return res.status(400).json({ error: 'shop_id, name, price required' });

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    // Vérifier ownership si vendeur
    const [shops] = await conn.query(`SELECT owner_id FROM shops WHERE id=?`, [shop_id]);
    const shop = shops[0];
    if (!shop) {
      conn.release();
      return res.status(400).json({ error: 'Invalid shop_id' });
    }
    if (isVendor(req.user) && shop.owner_id !== req.user.id) {
      conn.release();
      return res.status(403).json({ error: 'Forbidden: not your shop' });
    }

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO products (shop_id, category_id, name, slug, price, currency, description, stock, is_featured, promo_eligible, sub_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        shop_id,
        category_id || null,
        name,
        slug || null, // laisser NULL pour trigger auto
        price,
        currency || 'MAD',
        description || null,
        stock ?? 0,
        !!is_featured ? 1 : 0,
        !!promo_eligible ? 1 : 0,
        ['product','food','other'].includes(sub_category) ? sub_category : 'product'
      ]
    );
    const productId = r.insertId;

    // images
    for (let i = 0; i < images.length; i++) {
      await conn.query(
        `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
        [productId, images[i], i]
      );
    }

    // récupérer le slug (auto créé par trigger si NULL)
    const [[p]] = await conn.query(`SELECT slug FROM products WHERE id=?`, [productId]);
    await conn.commit();

    res.status(201).json({ id: productId, slug: p.slug });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// Update (owner/admin)
router.put('/:id', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const {
    name, price, currency, description, stock,
    is_featured, promo_eligible, sub_category, category_id
  } = req.body || {};
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [[prod]] = await conn.query(`SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`, [id]);
    if (!prod) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (isVendor(req.user) && prod.owner_id !== req.user.id) {
      conn.release(); return res.status(403).json({ error: 'Forbidden' });
    }

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
        sub_category && ['product','food','other'].includes(sub_category) ? sub_category : null,
        category_id ?? null,
        id
      ]
    );

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// Replace images (owner/admin)
router.put('/:id/images', authRequired, requireRole('VENDEUR','ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const { images = [] } = req.body || {};
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [[prod]] = await conn.query(`SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`, [id]);
    if (!prod) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
    if (isVendor(req.user) && prod.owner_id !== req.user.id) {
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
