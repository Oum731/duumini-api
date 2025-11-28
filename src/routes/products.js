// api/routes/products.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { getPool } = require("../lib/db");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { authRequired, requireRole, isVendor, isAdmin } = require("../middlewares/auth");

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

// Normalise la ville envoyée en query (?ville= / ?city=)
function normalizeVilleFilter(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const low = raw.toLowerCase();
  if (low.startsWith("cas")) return "Casablanca";
  if (low.startsWith("mar")) return "Marrakech";
  // fallback : renvoyer la chaîne telle quelle
  return raw;
}

// Taux de commission Duumini en fonction de la sous-catégorie
// sub = 'food' → 18% ; sinon (market/product/…) → 11%
function computeDuuminiRateFromSubCategory(subCategory) {
  const sub = String(subCategory || "").trim().toLowerCase();
  if (sub === "food") return 0.18; // Food
  return 0.11; // Market / autres
}

/**
 * Normalise un produit pour le front :
 * - price        = prix normal du produit (prix client final, tel qu'en BDD)
 * - vendor_price = montant net estimé pour le vendeur (price - commission Duumini)
 * - duumini_rate est masqué dans la réponse API
 *
 * 💡 Logique :
 *    → le pourcentage Duumini est DÉDIT du prix normal du produit (saisi par le vendeur),
 *       on NE l'ajoute pas au prix.
 *
 * Exemple :
 *    price = 50, rate = 0.18 → vendor_price = 50 - (50 * 0.18) = 41
 */
function stripDuuminiRateFromProduct(row) {
  if (!row) return row;

  const { duumini_rate, price, ...rest } = row;

  // Récupérer un taux valide, sinon calculer depuis sub_category
  let rate = computeDuuminiRateFromSubCategory(row.sub_category);
  if (duumini_rate != null) {
    const r = Number(duumini_rate);
    if (Number.isFinite(r) && r >= 0 && r <= 1) {
      rate = r;
    }
  }

  const clientPrice = Number(price || 0); // prix normal du produit (client, saisi dans le back-office)
  const duuminiAmount = +(clientPrice * rate).toFixed(2);
  const vendorNet = +(clientPrice - duuminiAmount).toFixed(2); // ce que touche le vendeur

  return {
    ...rest,
    price: clientPrice, // 💰 prix final payé par le client (inchangé)
    vendor_price: vendorNet, // net vendeur (après déduction commission)
  };
}

/**
 * Liste des produits avec filtres :
 * - channel: null | 'african-food' | 'african-market'
 * - onlyActive: bool
 * - ville: 'Casablanca' | 'Marrakech' | null
 */
async function listProducts(pool, { limit, offset, channel, onlyActive, ville }) {
  const normSub = "LOWER(TRIM(COALESCE(p.sub_category, '')))";
  const whereParts = [];
  const params = [];

  // Filtre par canal (food / market)
  if (channel === "african-food") {
    whereParts.push(`${normSub} = 'food'`);
  } else if (channel === "african-market") {
    whereParts.push(`${normSub} <> 'food'`);
  } else {
    whereParts.push("1=1");
  }

  // Filtre produits actifs
  if (onlyActive) {
    whereParts.push("p.is_active = 1");
  }

  // Filtre par ville de la boutique (s.city)
  if (ville) {
    whereParts.push("LOWER(TRIM(COALESCE(s.city, ''))) = LOWER(TRIM(?))");
    params.push(ville);
  }

  const whereSql = whereParts.length ? whereParts.join(" AND ") : "1=1";

  // COUNT avec join sur shops (pour ville)
  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
     WHERE ${whereSql}
    `,
    params
  );

  const [rowsRaw] = await pool.query(
    `
    SELECT 
      p.*,
      s.name AS shop_name,
      s.logo AS shop_logo,
      s.cover AS shop_cover,
      s.city AS shop_city,
      (SELECT url
         FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY sort_order ASC, id ASC
        LIMIT 1) AS cover
     FROM products p
     LEFT JOIN shops s ON s.id = p.shop_id
     WHERE ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?
    `,
    [...params, Number(limit), Number(offset)]
  );

  const rows = rowsRaw.map(stripDuuminiRateFromProduct);

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

  // Ville (user) → filtre sur shops.city
  const ville =
    normalizeVilleFilter(req.query.ville) ||
    normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      onlyActive,
      ville,
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

  const ville =
    normalizeVilleFilter(req.query.ville) ||
    normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-food",
      onlyActive,
      ville,
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

  const ville =
    normalizeVilleFilter(req.query.ville) ||
    normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-market",
      onlyActive,
      ville,
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
 * GET /api/products/top-ordered?limit=8&ville=Casablanca
 * → Retourne les produits les plus commandés (commandes DONE)
 *    filtrés éventuellement par ville (shops.city).
 */
router.get("/top-ordered", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const ville =
    normalizeVilleFilter(req.query.ville) ||
    normalizeVilleFilter(req.query.city);

  try {
    const whereVille = ville
      ? "AND LOWER(TRIM(COALESCE(s.city, ''))) = LOWER(TRIM(?))"
      : "";
    const params = [];
    if (ville) params.push(ville);
    params.push(limit);

    const [rowsRaw] = await pool.query(
      `
      SELECT 
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover,
        COALESCE(SUM(oi.qty), 0) AS total_qty
      FROM order_items oi
      JOIN orders o   ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN shops s ON s.id = p.shop_id
      WHERE o.status = 'DONE'
        AND p.is_active = 1
        ${whereVille}
      GROUP BY p.id
      ORDER BY total_qty DESC
      LIMIT ?
      `,
      params
    );

    const rows = rowsRaw.map(stripDuuminiRateFromProduct);

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : mieux notés ----------------------------- */
/**
 * GET /api/products/top-rated?limit=8&minCount=2&ville=Casablanca
 * → Retourne les produits les mieux notés (moyenne + nb avis)
 *    filtrés éventuellement par ville.
 */
router.get("/top-rated", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const minCount = toPositiveInt(req.query.minCount, 2);
  const ville =
    normalizeVilleFilter(req.query.ville) ||
    normalizeVilleFilter(req.query.city);

  try {
    const whereVille = ville
      ? "AND LOWER(TRIM(COALESCE(s.city, ''))) = LOWER(TRIM(?))"
      : "";
    const params = [];
    params.push(minCount);
    if (ville) params.push(ville);
    params.push(limit);

    const [rowsRaw] = await pool.query(
      `
      SELECT 
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city,
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
      LEFT JOIN shops s ON s.id = p.shop_id
      GROUP BY p.id
      HAVING rating_count >= ?
      ${whereVille}
      ORDER BY avg_rating DESC, rating_count DESC
      LIMIT ?
      `,
      params
    );

    const rows = rowsRaw.map(stripDuuminiRateFromProduct);

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
    const [rows] = await pool.query(
      `SELECT 
         p.*,
         s.name AS shop_name,
         s.logo AS shop_logo,
         s.cover AS shop_cover,
         s.city AS shop_city
       FROM products p
       LEFT JOIN shops s ON s.id = p.shop_id
       WHERE p.id=?`,
      [id]
    );
    const rawProduct = rows[0];
    if (!rawProduct) return res.status(404).json({ error: "Not found" });

    const product = stripDuuminiRateFromProduct(rawProduct);

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
 *  - name, price (⚠️ prix normal du produit = prix client final saisi par le vendeur)
 *  - shop_id (OBLIGATOIRE pour ADMIN, ignoré pour VENDEUR)
 *  - currency?, description?, stock?, is_featured?, promo_eligible?, sub_category? ('product'|'food'), is_active?
 *  - images[] (max 8)
 *
 * Règles:
 *  - VENDEUR: shop_id déduit de la boutique du vendeur (obligatoire pour lui)
 *  - ADMIN:  shop_id doit être fourni, on vérifie que la boutique existe
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
      shop_id,
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
        // ADMIN: shop_id DOIT être fourni et valide
        const sid = Number(shop_id) || 0;
        if (!sid) {
          conn.release();
          return res
            .status(400)
            .json({ error: "shop_id requis pour la création par un admin" });
        }
        const [[shop]] = await conn.query(
          `SELECT id FROM shops WHERE id=? LIMIT 1`,
          [sid]
        );
        if (!shop) {
          conn.release();
          return res.status(400).json({ error: "Boutique invalide (shop_id)" });
        }
        finalShopId = sid;
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
      const sub =
        rawSub === "food" || rawSub === "product" ? rawSub : "product";

      // Calcul du taux de commission Duumini (caché du front)
      const duuminiRate = computeDuuminiRateFromSubCategory(sub);

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
           (shop_id, category_id, name, slug, price, currency, description, stock, is_featured, promo_eligible, sub_category, duumini_rate, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          finalShopId,
          category_id ? Number(category_id) : null,
          name,
          makeSlug(),
          Number(price), // prix normal du produit (client, saisi par le vendeur)
          currency || "MAD",
          description || null,
          stock != null ? Number(stock) : 0,
          is_featured ? 1 : 0,
          promo_eligible ? 1 : 0,
          sub,
          duuminiRate,
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
        console.error(
          "[products] Failed to enqueue PRODUCT_CREATED notifications",
          e
        );
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
      shop_id,
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
      let sub = null;
      if (rawSub === "food" || rawSub === "product") {
        sub = rawSub;
      }

      // Sous-catégorie effective (si pas envoyée, on garde l'existant)
      const effectiveSub =
        sub != null
          ? sub
          : String(prod.sub_category || "").trim().toLowerCase() || "product";

      // Recalcul du taux Duumini en fonction de la sous-catégorie effective
      const duuminiRate = computeDuuminiRateFromSubCategory(effectiveSub);

      // Normaliser is_active si fourni
      const active = parseBoolFlag(is_active, null);

      // Gestion éventuelle du changement de boutique (ADMIN uniquement)
      let newShopIdParam = null;
      if (shop_id != null && shop_id !== "") {
        const sid = Number(shop_id) || 0;
        if (sid > 0 && isAdmin(req.user)) {
          const [[shop]] = await conn.query(
            `SELECT id FROM shops WHERE id=? LIMIT 1`,
            [sid]
          );
          if (!shop) {
            conn.release();
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          newShopIdParam = sid;
        }
        // Si vendeur -> on ignore tout changement de shop_id
      }

      await conn.query(
        `UPDATE products SET
           name          = COALESCE(?, name),
           price         = COALESCE(?, price),
           currency      = COALESCE(?, currency),
           description   = COALESCE(?, description),
           stock         = COALESCE(?, stock),
           is_featured   = COALESCE(?, is_featured),
           promo_eligible= COALESCE(?, promo_eligible),
           sub_category  = ?,
           duumini_rate  = ?,
           is_active     = COALESCE(?, is_active),
           category_id   = COALESCE(?, category_id),
           shop_id       = COALESCE(?, shop_id)
         WHERE id=?`,
        [
          name ?? null,
          // prix normal (client, saisi dans le back-office)
          price != null ? Number(price) : null,
          currency ?? null,
          description ?? null,
          stock != null ? Number(stock) : null,
          is_featured === undefined ? null : is_featured ? 1 : 0,
          promo_eligible === undefined ? null : promo_eligible ? 1 : 0,
          effectiveSub,
          duuminiRate,
          active,
          category_id != null ? Number(category_id) : null,
          newShopIdParam,
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

/* =======================================================================
 *  Route de partage avec meta OG
 *  GET /share/product/:id   (monté via productsRouter.shareRouter côté server.js)
 * ======================================================================= */

const shareRouter = express.Router();

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

shareRouter.get("/product/:id", async (req, res, next) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    return res.status(404).send("Not found");
  }

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.price,
        p.sub_category,
        p.is_active,
        s.name AS shop_name,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
      WHERE p.id = ?
      `,
      [id]
    );

    const product = rows[0];
    if (!product || !product.is_active) {
      return res.status(404).send("Not found");
    }

    // Base Duumini web
    const baseWeb =
      env.FRONT_WEB_BASE_URL ||
      process.env.FRONT_WEB_BASE_URL ||
      "https://www.duumini.com";

    // food -> /african-food, sinon -> /african-market
    const sub = String(product.sub_category || "").trim().toLowerCase();
    const channelPath = sub === "food" ? "/african-food" : "/african-market";
    const finalUrl = `${baseWeb}${channelPath}`;

    const ogTitle = escapeHtml(
      `${product.name} — Duumini${
        product.shop_name ? ` (${product.shop_name})` : ""
      }`
    );

    const descriptionRaw =
      product.description ||
      "Découvrez ce produit africain disponible sur Duumini.";
    const ogDescription = escapeHtml(
      descriptionRaw.length > 180
        ? descriptionRaw.slice(0, 177) + "..."
        : descriptionRaw
    );

    // Image OG = cover produit si possible
    let ogImage = product.cover || null;

    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      // Si jamais c'est une URL relative, on la colle sur baseWeb
      if (ogImage.startsWith("/")) {
        ogImage = `${baseWeb}${ogImage}`;
      }
    }

    if (!ogImage) {
      // Fallback image catégorie
      ogImage = `${baseWeb}/images/share-default-product.jpg`;
    }

    const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${ogTitle}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <!-- Open Graph -->
    <meta property="og:type" content="product" />
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:description" content="${ogDescription}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:url" content="${finalUrl}" />

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${ogTitle}" />
    <meta name="twitter:description" content="${ogDescription}" />
    <meta name="twitter:image" content="${ogImage}" />

    <!-- Redirection vers la catégorie Duumini -->
    <meta http-equiv="refresh" content="0;url=${finalUrl}" />
    <script>
      window.location.replace(${JSON.stringify(finalUrl)});
    </script>
  </head>
  <body>
    <p>Redirection vers <a href="${finalUrl}">${finalUrl}</a>…</p>
  </body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    next(e);
  }
});

/* Export principal API + sous-router de partage */
module.exports = router;
module.exports.shareRouter = shareRouter;
