// src/routes/productRatings.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired } = require("../middlewares/auth");

const router = Router();

function parseProductId(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * GET /api/products/:id/ratings
 * → moyenne + nombre de notes pour un produit
 */
router.get("/:id/ratings", async (req, res) => {
  const productId = parseProductId(req.params.id);
  if (!productId) {
    return res.status(400).json({ error: "product_id invalide" });
  }

  const pool = getPool();
  try {
    const [existsRows] = await pool.query(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    if (!existsRows.length) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    const [rows] = await pool.query(
      `SELECT AVG(rating) AS average, COUNT(*) AS count
       FROM product_ratings
       WHERE product_id = ?`,
      [productId]
    );

    const average = rows[0]?.average ? Number(rows[0].average) : 0;
    const count = rows[0]?.count ? Number(rows[0].count) : 0;

    res.json({ average, count });
  } catch (e) {
    console.error("GET /products/:id/ratings error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /api/products/:id/ratings/list
 * → liste détaillée des avis pour un produit
 */
router.get("/:id/ratings/list", async (req, res) => {
  const productId = parseProductId(req.params.id);
  if (!productId) {
    return res.status(400).json({ error: "product_id invalide" });
  }

  const pool = getPool();
  try {
    const [existsRows] = await pool.query(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    if (!existsRows.length) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    const [rows] = await pool.query(
      `SELECT
         pr.id,
         pr.rating,
         pr.comment,
         pr.created_at,
         pr.user_id,
         CASE
           WHEN TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) <> '' THEN
             TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))
           WHEN u.phone IS NOT NULL AND u.phone <> '' THEN
             u.phone
           ELSE
             'Client Duumini'
         END AS user_name
       FROM product_ratings pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.product_id = ?
       ORDER BY pr.created_at DESC`,
      [productId]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("GET /products/:id/ratings/list error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /api/products/pending-rating
 * → retourne UN produit que l'utilisateur doit noter
 *   (commande livrée depuis ≥ 24h, pas encore notée par cet utilisateur).
 */
router.get("/pending-rating", authRequired, async (req, res) => {
  const userId = req.user.id;
  const pool = getPool();

  try {
    /**
     * Schéma aligné avec orders.js :
     * - orders(id, user_id, status, total, currency, address, contact, geo_link, created_at, updated_at)
     * - order_items(id, order_id, product_id, qty, unit_price, ...)
     * - products(id, name, price, ...)
     * - product_images(id, product_id, url, sort_order, ...)
     * - product_ratings(id, product_id, user_id, rating, comment, created_at, ...)
     *
     * On prend la date de "livraison" comme :
     *   COALESCE(o.updated_at, o.created_at)
     */
    const [rows] = await pool.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         (
           SELECT pi.url
           FROM product_images pi
           WHERE pi.product_id = p.id
           ORDER BY pi.sort_order ASC, pi.id ASC
           LIMIT 1
         ) AS product_image,
         o.id AS order_id,
         COALESCE(o.updated_at, o.created_at) AS delivered_at
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p      ON p.id = oi.product_id
       LEFT JOIN product_ratings pr
         ON pr.product_id = p.id
        AND pr.user_id   = o.user_id
       WHERE o.user_id = ?
         AND o.status = 'DONE'
         AND pr.id IS NULL
         AND COALESCE(o.updated_at, o.created_at) <= (NOW() - INTERVAL 24 HOUR)
       ORDER BY delivered_at DESC
       LIMIT 1`,
      [userId]
    );

    const pending = rows[0] || null;
    res.json(pending);
  } catch (e) {
    console.error("GET /products/pending-rating error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * POST /api/products/:id/rate
 * Body: { rating: 1-5, comment?: string }
 * → crée ou met à jour la note de l'utilisateur connecté
 */
router.post("/:id/rate", authRequired, async (req, res) => {
  const productId = parseProductId(req.params.id);
  let { rating, comment } = req.body || {};

  if (!productId) {
    return res.status(400).json({ error: "product_id invalide" });
  }

  rating = Number(rating);
  comment = comment ? String(comment).trim() : null;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res
      .status(400)
      .json({ error: "rating doit être un entier entre 1 et 5" });
  }

  if (comment && comment.length > 2000) {
    comment = comment.slice(0, 2000);
  }

  const userId = req.user.id;
  const pool = getPool();

  try {
    const [existsRows] = await pool.query(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    if (!existsRows.length) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    await pool.query(
      `INSERT INTO product_ratings (product_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         rating = VALUES(rating),
         comment = VALUES(comment),
         updated_at = CURRENT_TIMESTAMP`,
      [productId, userId, rating, comment]
    );

    const [rows] = await pool.query(
      `SELECT AVG(rating) AS average, COUNT(*) AS count
       FROM product_ratings
       WHERE product_id = ?`,
      [productId]
    );

    const average = rows[0]?.average ? Number(rows[0].average) : 0;
    const count = rows[0]?.count ? Number(rows[0].count) : 0;

    res.json({
      ok: true,
      average,
      count,
      user_rating: rating,
      comment,
    });
  } catch (e) {
    console.error("POST /products/:id/rate error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * DELETE /api/products/:id/rate
 * → supprime la note de l'utilisateur connecté pour ce produit
 */
router.delete("/:id/rate", authRequired, async (req, res) => {
  const productId = parseProductId(req.params.id);
  if (!productId) {
    return res.status(400).json({ error: "product_id invalide" });
  }

  const userId = req.user.id;
  const pool = getPool();

  try {
    const [existsRows] = await pool.query(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    if (!existsRows.length) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

    const [result] = await pool.query(
      `DELETE FROM product_ratings
       WHERE product_id = ? AND user_id = ?`,
      [productId, userId]
    );

    const deleted = result.affectedRows > 0;

    const [rows] = await pool.query(
      `SELECT AVG(rating) AS average, COUNT(*) AS count
       FROM product_ratings
       WHERE product_id = ?`,
      [productId]
    );

    const average = rows[0]?.average ? Number(rows[0].average) : 0;
    const count = rows[0]?.count ? Number(rows[0].count) : 0;

    res.json({
      ok: true,
      deleted,
      average,
      count,
    });
  } catch (e) {
    console.error("DELETE /products/:id/rate error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
