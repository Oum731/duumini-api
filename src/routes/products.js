// src/routes/products.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { getPool } = require("../lib/db");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { authRequired, requireRole, isVendor } = require("../middlewares/auth");

// --- Cloudinary ---
const cloudinary = require("cloudinary").v2;
const { env } = require("../lib/env");

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

// Upload buffer -> Cloudinary (stream)
function uploadBufferToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const folder = `products/${now.getFullYear()}/${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`;

    const upload = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: filename ? filename.replace(/\.[^.]+$/, "") : undefined,
        resource_type: "image",
        overwrite: false,
        invalidate: false,
      },
      (err, res) => {
        if (err) return reject(err);
        resolve(res);
      }
    );

    upload.end(buffer);
  });
}

const router = express.Router();

/* =========================
 * Upload (Cloudinary via mémoire)
 * ========================= */

// On garde ces constantes pour compat, même si on ne sert plus de local
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(UPLOAD_DIR);

// ⚠️ On passe en mémoire : les fichiers ne sont plus écrits sur disque
const upload = multer({ storage: multer.memoryStorage() });

/* ----------------------------- Helpers ----------------------------- */

// Sécurise un param numérique (évite NaN, négatifs, etc.)
function toPositiveInt(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

// parse un param ID; renvoie null si non numérique
function parseIdParam(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// Helper pour parser un booléen / flag (0/1, true/false, yes/no, on/off)
function parseBoolFlag(value, defaultValue = null) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

async function listProducts(pool, { limit, offset, channel, onlyActive }) {
  // Normalisation SQL pour tolérer Food / ' food ' / '' / NULL
  const norm = "LOWER(TRIM(COALESCE(p.sub_category, '')))";

  let where = "1=1";
  if (channel === "african-food") {
    // Uniquement FOOD (normalisé)
    where = `${norm} = 'food'`;
  } else if (channel === "african-market") {
    // Tout ce qui n'est PAS 'food' : 'product', NULL, vide, legacy…
    where = `${norm} <> 'food'`;
  }

  // Filtre produits actifs si demandé
  if (onlyActive) {
    where = `(${where}) AND p.is_active = 1`;
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM products p
      WHERE ${where}`
  );

  const [rows] = await pool.query(
    `SELECT p.*,
            (SELECT url
               FROM product_images pi
              WHERE pi.product_id = p.id
              ORDER BY sort_order ASC, id ASC
              LIMIT 1) AS cover
       FROM products p
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
  );

  return { rows, total };
}

/* ----------------------------- Listing ----------------------------- */
// Handler générique (sans canal)
async function listHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      onlyActive,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

// Handler spécifique FOOD
async function listFoodHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-food",
      onlyActive,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

// Handler spécifique MARKET (non-food)
async function listMarketHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-market",
      onlyActive,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

// Routes listing
router.get("/", listHandler);
router.get("/african-food", listFoodHandler);
router.get("/african-market", listMarketHandler);

/* ----------------------------- Top produits : plus commandés ----------------------------- */
/**
 * GET /api/products/top-ordered?limit=8
 * → Retourne les produits les plus commandés (commandes DONE)
 */
router.get("/top-ordered", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8); // ✅ pas de NaN

  try {
    const [rows] = await pool.query(
      `
      SELECT 
        p.*,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover,
        COALESCE(SUM(oi.qty), 0) AS total_qty
      FROM order_items oi
      JOIN orders o   ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.status = 'DONE'
        AND p.is_active = 1
      GROUP BY p.id
      ORDER BY total_qty DESC
      LIMIT ?
      `,
      [limit]
    );

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : mieux notés ----------------------------- */
/**
 * GET /api/products/top-rated?limit=8&minCount=2
 * → Retourne les produits les mieux notés (moyenne + nb avis)
 */
router.get("/top-rated", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const minCount = toPositiveInt(req.query.minCount, 2);

  try {
    const [rows] = await pool.query(
      `
      SELECT 
        p.*,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover,
        AVG(r.rating)     AS avg_rating,
        COUNT(r.id)       AS rating_count
      FROM product_ratings r
      JOIN products p ON p.id = r.product_id
                     AND p.is_active = 1
      GROUP BY p.id
      HAVING rating_count >= ?
      ORDER BY avg_rating DESC, rating_count DESC
      LIMIT ?
      `,
      [minCount, limit]
    );

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Read one ----------------------------- */
router.get("/:id", async (req, res, next) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    // ID non numérique (ex: "pending-rating") → laisse passer au prochain router
    return next();
  }

  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: "Not found" });

    const [images] = await pool.query(
      `SELECT id, url, sort_order
         FROM product_images
        WHERE product_id=?
        ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    res.json({ ...product, images });
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Create (multipart) ----------------------------- */
/**
 * FormData attendu:
 *  - name, price
 *  - currency?, description?, stock?, is_featured?, promo_eligible?, sub_category? ('product'|'food'), is_active?
 *  - images[] (max 8)
 *
 * Règles:
 *  - VENDEUR: shop_id déduit de la boutique du vendeur (obligatoire pour lui)
 *  - ADMIN:  AUCUN système boutique → shop_id = NULL
 */
router.post(
  "/",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 8),
  async (req, res, next) => {
    const {
      category_id,
      name,
      slug,
      price,
      currency,
      description,
      stock,
      is_featured,
      promo_eligible,
      sub_category,
      is_active,
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      // Détermination du shop_id selon le rôle
      let finalShopId = null;
      const role = String(req.user?.role || "").toUpperCase();

      if (role === "VENDEUR") {
        const [[shop]] = await conn.query(
          `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
          [req.user.id]
        );
        if (!shop) {
          conn.release();
          return res
            .status(400)
            .json({ error: "Aucune boutique associée à ce vendeur" });
        }
        finalShopId = Number(shop.id);
      } else if (role === "ADMIN") {
        finalShopId = null; // ADMIN: pas de système boutique
      } else {
        conn.release();
        return res.status(403).json({ error: "Forbidden" });
      }

      if (!name || price == null) {
        conn.release();
        return res.status(400).json({ error: "name et price requis" });
      }

      // Normaliser sub_category: 'food' | 'product' (par défaut 'product')
      const rawSub = String(sub_category || "").trim().toLowerCase();
      const sub = rawSub === "food" || rawSub === "product" ? rawSub : "product";

      // Normaliser is_active (par défaut 1 = actif)
      const active = parseBoolFlag(is_active, 1);

      const makeSlug = () =>
        (slug && String(slug).trim()) ||
        `${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 7)}`.toLowerCase();

      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO products
           (shop_id, category_id, name, slug, price, currency, description, stock, is_featured, promo_eligible, sub_category, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          finalShopId, // ← NULL pour ADMIN
          category_id ? Number(category_id) : null,
          name,
          makeSlug(),
          Number(price),
          currency || "MAD",
          description || null,
          stock != null ? Number(stock) : 0,
          is_featured ? 1 : 0,
          promo_eligible ? 1 : 0,
          sub,
          active,
        ]
      );
      const productId = r.insertId;

      // Images -> Cloudinary
      const files = Array.isArray(req.files) ? req.files : [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
        const up = await uploadBufferToCloudinary(
          f.buffer,
          f.originalname || undefined
        );
        const webUrl = up?.secure_url || up?.url;
        if (!webUrl) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [productId, webUrl, i]
        );
      }

      await conn.commit();

      const channel = sub === "food" ? "african-food" : "african-market";

      // 🟢 Enquêter une notification pour TOUS les users ayant un device
      try {
        const [userRows] = await pool.query(
          `SELECT DISTINCT user_id
             FROM user_devices
            WHERE provider = 'pushy'`
        );

        if (userRows.length) {
          const payload = {
            title: "Nouveau produit disponible",
            body: `${name} est maintenant disponible sur Duumini`,
            product_id: productId,
            channel,
          };
          const payloadJson = JSON.stringify(payload);

          for (const row of userRows) {
            await pool.query(
              `INSERT INTO notification_queue (user_id, type, payload, status)
               VALUES (?,?,?, 'queued')`,
              [row.user_id, "PRODUCT_CREATED", payloadJson]
            );
          }
        }
      } catch (e) {
        console.error("[products] Failed to enqueue PRODUCT_CREATED notifications", e);
      }

      // Notif temps réel (optionnel) — seulement si un shop existe
      try {
        const { getIO, emitToShops } = require("../ws");
        const io = getIO && getIO();
        if (io && emitToShops && finalShopId != null) {
          emitToShops([finalShopId], "product:created", { product_id: productId });
        }
      } catch {}

      res.status(201).json({ id: productId, channel });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate slug" });
      }
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Update (multipart ou JSON) ----------------------------- */
router.put(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 8),
  async (req, res, next) => {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return next();
    }

    const {
      name,
      price,
      currency,
      description,
      stock,
      is_featured,
      promo_eligible,
      sub_category,
      category_id,
      replace_images,
      is_active,
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      // LEFT JOIN pour supporter produits ADMIN sans boutique
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id
           FROM products p
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE p.id=?`,
        [id]
      );
      if (!prod) {
        conn.release();
        return res.status(404).json({ error: "Not found" });
      }
      // Vendeur: uniquement ses produits (owner_id NULL => interdit)
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release();
        return res.status(403).json({ error: "Forbidden" });
      }

      // Normaliser sub_category: appliquer uniquement si valeur valide
      const rawSub =
        sub_category != null ? String(sub_category).trim().toLowerCase() : null;
      const sub = rawSub === "food" || rawSub === "product" ? rawSub : null;

      // Normaliser is_active si fourni
      const active = parseBoolFlag(is_active, null);

      await conn.query(
        `UPDATE products SET
           name          = COALESCE(?, name),
           price         = COALESCE(?, price),
           currency      = COALESCE(?, currency),
           description   = COALESCE(?, description),
           stock         = COALESCE(?, stock),
           is_featured   = COALESCE(?, is_featured),
           promo_eligible= COALESCE(?, promo_eligible),
           sub_category  = COALESCE(?, sub_category),
           is_active     = COALESCE(?, is_active),
           category_id   = COALESCE(?, category_id)
         WHERE id=?`,
        [
          name ?? null,
          price != null ? Number(price) : null,
          currency ?? null,
          description ?? null,
          stock != null ? Number(stock) : null,
          is_featured === undefined ? null : is_featured ? 1 : 0,
          promo_eligible === undefined ? null : promo_eligible ? 1 : 0,
          sub,
          active,
          category_id != null ? Number(category_id) : null,
          id,
        ]
      );

      // Images -> Cloudinary
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        const doReplace = String(replace_images || "").toLowerCase() === "true";
        if (doReplace) {
          await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
        }
        const [[{ maxOrder }]] = await conn.query(
          `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_images WHERE product_id=?`,
          [id]
        );
        let start = (maxOrder ?? -1) + 1;
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
          const up = await uploadBufferToCloudinary(
            f.buffer,
            f.originalname || undefined
          );
          const webUrl = up?.secure_url || up?.url;
          if (!webUrl) continue;
          await conn.query(
            `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
            [id, webUrl, start + i]
          );
        }
      }

      // Notifs (optionnel)
      try {
        const { getIO } = require("../ws");
        const io = getIO && getIO();
        if (io && io.broadcastToUser && prod.owner_id != null) {
          io.broadcastToUser(prod.owner_id, "product:updated", { product_id: id });
        }
      } catch {}

      res.json({ ok: true });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Replace images ----------------------------- */
router.put(
  "/:id/images",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 8),
  async (req, res, next) => {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return next();
    }

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id
           FROM products p
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE p.id=?`,
        [id]
      );
      if (!prod) {
        conn.release();
        return res.status(404).json({ error: "Not found" });
      }
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release();
        return res.status(403).json({ error: "Forbidden" });
      }

      const bodyImages = Array.isArray(req.body?.images) ? req.body.images : [];
      const files = Array.isArray(req.files) ? req.files : [];

      await conn.beginTransaction();
      await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);

      let order = 0;
      // URLs passées dans le body (Cloudinary direct)
      for (const url of bodyImages) {
        const u = String(url || "").trim();
        if (!u) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [id, u, order++]
        );
      }
      // Fichiers -> Cloudinary
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
        const up = await uploadBufferToCloudinary(
          f.buffer,
          f.originalname || undefined
        );
        const webUrl = up?.secure_url || up?.url;
        if (!webUrl) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [id, webUrl, order++]
        );
      }

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Delete ----------------------------- */
router.delete(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  async (req, res, next) => {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return next();
    }

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id
           FROM products p
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE p.id=?`,
        [id]
      );
      if (!prod) {
        conn.release();
        return res.status(404).json({ error: "Not found" });
      }
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release();
        return res.status(403).json({ error: "Forbidden" });
      }

      const [imgs] = await conn.query(
        `SELECT url FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`,
        [id]
      );

      await conn.beginTransaction();
      await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
      await conn.query(`DELETE FROM products WHERE id=?`, [id]);
      await conn.commit();

      // Nettoyage local (inutile si Cloudinary, inoffensif sinon)
      for (const it of imgs) {
        const u = String(it.url || "");
        if (!u.startsWith("/uploads/")) continue;
        const abs = path
          .join(
            process.cwd(),
            u.replace(/^\//, "").replace(/\//g, path.sep)
          );
        fs.promises.unlink(abs).catch(() => {});
      }

      // Notif (optionnel)
      try {
        const { getIO } = require("../ws");
        const io = getIO && getIO();
        if (io && io.broadcastToUser && prod.owner_id != null) {
          io.broadcastToUser(prod.owner_id, "product:deleted", { product_id: id });
        }
      } catch {}

      res.json({ ok: true });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
