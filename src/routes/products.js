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
    const folder = `products/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;

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

// compat: plus de local, mais on garde le dossier
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(UPLOAD_DIR);

const upload = multer({ storage: multer.memoryStorage() });

/* ----------------------------- Helpers ----------------------------- */

function toPositiveInt(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

function parseIdParam(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseBoolFlag(value, defaultValue = null) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

function normalizeVilleFilter(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const low = raw.toLowerCase();
  if (low.startsWith("cas")) return "Casablanca";
  if (low.startsWith("mar")) return "Marrakech";
  return raw;
}

function expandCasaMarr(ville) {
  const v = normalizeVilleFilter(ville);
  if (!v) return null;
  if (v === "Casablanca" || v === "Marrakech") return ["Casablanca", "Marrakech"];
  return [v];
}

/* ============================
 *  Villes dispo (colonne optionnelle)
 * ============================ */

async function detectCitiesColumn(conn) {
  const candidates = ["available_cities", "cities", "villes"];
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return candidates.find((c) => found.has(c)) || null;
}

function parseCitiesBody(body) {
  const raw =
    body?.cities ??
    body?.["cities[]"] ??
    body?.villes ??
    body?.["villes[]"] ??
    null;

  if (raw == null) return null;

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else {
    const s = String(raw || "").trim();
    if (!s) arr = [];
    else if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        arr = Array.isArray(parsed) ? parsed : [];
      } catch {
        arr = [];
      }
    } else if (s.includes(",")) {
      arr = s.split(",").map((x) => x.trim());
    } else {
      arr = [s];
    }
  }

  const out = [];
  const seen = new Set();
  for (const it of arr) {
    const c = normalizeVilleFilter(it) || String(it || "").trim();
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/* ============================
 * Promotions
 * ============================ */

function normalizePromoType(value) {
  const t = String(value || "").trim().toUpperCase();
  if (t === "AMOUNT") return "AMOUNT";
  if (t === "PERCENT") return "PERCENT";
  return "PERCENT";
}

function parsePromoFields(body) {
  const eligible = parseBoolFlag(body?.promo_eligible, null);

  const freeDelivery =
    body?.promo_free_delivery === undefined ? null : parseBoolFlag(body?.promo_free_delivery, 0);

  if (eligible === null) {
    return {
      promo_eligible: null,
      promo_discount_type: null,
      promo_discount_value: null,
      promo_free_delivery: freeDelivery,
      promo_mode: "UNTOUCHED",
    };
  }

  if (eligible === 0) {
    return {
      promo_eligible: 0,
      promo_discount_type: null,
      promo_discount_value: null,
      promo_free_delivery: freeDelivery,
      promo_mode: "OFF",
    };
  }

  const type = normalizePromoType(body?.promo_discount_type);
  const v = Number(body?.promo_discount_value);
  const value = Number.isFinite(v) && v > 0 ? v : null;

  return {
    promo_eligible: 1,
    promo_discount_type: value ? type : null,
    promo_discount_value: value,
    promo_free_delivery: freeDelivery,
    promo_mode: "ON",
  };
}

/* ============================
 * SubCategory (table)
 * ============================ */

function computeDuuminiRateFromSubCategorySlug(subSlug) {
  const sub = String(subSlug || "").trim().toLowerCase();
  if (sub === "food") return 0.18;
  return 0.11;
}

function stripDuuminiRateFromProduct(row) {
  if (!row) return row;

  const { duumini_rate, price, ...rest } = row;

  let rate = computeDuuminiRateFromSubCategorySlug(row.sub_category_slug || row.sub_category);
  if (duumini_rate != null) {
    const r = Number(duumini_rate);
    if (Number.isFinite(r) && r >= 0 && r <= 1) rate = r;
  }

  const clientPrice = Number(price || 0);
  const duuminiAmount = +(clientPrice * rate).toFixed(2);
  const vendorNet = +(clientPrice - duuminiAmount).toFixed(2);

  return {
    ...rest,
    price: clientPrice,
    vendor_price: vendorNet,
  };
}

async function resolveSubCategory(conn, { sub_category_id, category_id }) {
  const sid = Number(sub_category_id) || 0;
  if (!sid) return null;

  if (category_id) {
    const cid = Number(category_id) || 0;
    const [rows] = await conn.query(
      `SELECT id, category_id, name, slug
         FROM sub_categories
        WHERE id=? AND category_id=?
        LIMIT 1`,
      [sid, cid]
    );
    return rows[0] || null;
  }

  const [rows] = await conn.query(
    `SELECT id, category_id, name, slug
       FROM sub_categories
      WHERE id=?
      LIMIT 1`,
    [sid]
  );
  return rows[0] || null;
}

/**
 * Liste des produits avec filtres :
 * - channel: null | 'african-food' | 'african-market'
 * - onlyActive: bool
 * - ville: Casablanca | Marrakech | autre
 * - onlyPromos: bool
 */
async function listProducts(pool, { limit, offset, channel, onlyActive, ville, onlyPromos }) {
  const whereParts = [];
  const params = [];

  if (channel === "african-food") whereParts.push(`LOWER(TRIM(COALESCE(sc.slug,''))) = 'food'`);
  else if (channel === "african-market")
    whereParts.push(`(LOWER(TRIM(COALESCE(sc.slug,''))) <> 'food' OR sc.slug IS NULL)`);
  else whereParts.push("1=1");

  if (onlyActive) whereParts.push("p.is_active = 1");

  if (onlyPromos) {
    whereParts.push(`(p.promo_eligible = 1 AND COALESCE(p.promo_discount_value, 0) > 0)`);
  }

  const villes = ville ? expandCasaMarr(ville) : null;
  if (villes && villes.length) {
    const placeholders = villes.map(() => "?").join(",");
    whereParts.push(`LOWER(TRIM(COALESCE(s.city,''))) IN (${placeholders})`);
    params.push(...villes);
  }

  const whereSql = whereParts.length ? whereParts.join(" AND ") : "1=1";

  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
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

      c.name AS category_name,
      c.slug AS category_slug,

      sc.id   AS sub_category_id,
      sc.name AS sub_category_name,
      sc.slug AS sub_category_slug,

      (SELECT url
         FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY sort_order ASC, id ASC
        LIMIT 1) AS cover
     FROM products p
     LEFT JOIN shops s ON s.id = p.shop_id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
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
async function listHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);

  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      onlyActive,
      ville,
      onlyPromos: false,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

async function listFoodHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);

  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-food",
      onlyActive,
      ville,
      onlyPromos: false,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

async function listMarketHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);

  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-market",
      onlyActive,
      ville,
      onlyPromos: false,
    });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}

router.get("/", listHandler);
router.get("/african-food", listFoodHandler);
router.get("/african-market", listMarketHandler);

/* ----------------------------- Promotions list ----------------------------- */
router.get("/promotions", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 12);

  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  const onlyActive =
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on";

  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  const channel = String(req.query.channel || "all").toLowerCase();
  const channelNorm =
    channel === "african-food" ? "african-food" : channel === "african-market" ? "african-market" : null;

  try {
    const { rows } = await listProducts(pool, {
      limit,
      offset: 0,
      channel: channelNorm,
      onlyActive,
      ville,
      onlyPromos: true,
    });

    res.json(rows.slice(0, limit));
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : plus commandés ----------------------------- */
router.get("/top-ordered", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  try {
    const villes = ville ? expandCasaMarr(ville) : null;
    const whereVille = villes?.length
      ? `AND LOWER(TRIM(COALESCE(s.city,''))) IN (${villes.map(() => "?").join(",")})`
      : "";

    const params = [];
    if (villes?.length) params.push(...villes);
    params.push(limit);

    const [rowsRaw] = await pool.query(
      `
      SELECT 
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city,

        c.name AS category_name,
        c.slug AS category_slug,

        sc.id   AS sub_category_id,
        sc.name AS sub_category_name,
        sc.slug AS sub_category_slug,

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
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      WHERE o.status = 'DONE'
        AND p.is_active = 1
        ${whereVille}
      GROUP BY p.id
      ORDER BY total_qty DESC
      LIMIT ?
      `,
      params
    );

    res.json(rowsRaw.map(stripDuuminiRateFromProduct));
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : mieux notés ----------------------------- */
router.get("/top-rated", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const minCount = toPositiveInt(req.query.minCount, 2);
  const ville = normalizeVilleFilter(req.query.ville) || normalizeVilleFilter(req.query.city);

  try {
    const villes = ville ? expandCasaMarr(ville) : null;
    const whereVille = villes?.length
      ? `AND LOWER(TRIM(COALESCE(s.city,''))) IN (${villes.map(() => "?").join(",")})`
      : "";

    const params = [minCount];
    if (villes?.length) params.push(...villes);
    params.push(limit);

    const [rowsRaw] = await pool.query(
      `
      SELECT 
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city,

        c.name AS category_name,
        c.slug AS category_slug,

        sc.id   AS sub_category_id,
        sc.name AS sub_category_name,
        sc.slug AS sub_category_slug,

        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover,
        AVG(r.rating)     AS avg_rating,
        COUNT(r.id)       AS rating_count
      FROM product_ratings r
      JOIN products p ON p.id = r.product_id AND p.is_active = 1
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      GROUP BY p.id
      HAVING rating_count >= ?
      ${whereVille}
      ORDER BY avg_rating DESC, rating_count DESC
      LIMIT ?
      `,
      params
    );

    res.json(rowsRaw.map(stripDuuminiRateFromProduct));
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Read one ----------------------------- */
router.get("/:id", async (req, res, next) => {
  const id = parseIdParam(req.params.id);
  if (!id) return next();

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT 
         p.*,
         s.name AS shop_name,
         s.logo AS shop_logo,
         s.cover AS shop_cover,
         s.city AS shop_city,

         c.name AS category_name,
         c.slug AS category_slug,

         sc.id   AS sub_category_id,
         sc.name AS sub_category_name,
         sc.slug AS sub_category_slug
       FROM products p
       LEFT JOIN shops s ON s.id = p.shop_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
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

    let cities = undefined;
    try {
      const conn = await pool.getConnection();
      try {
        const col = await detectCitiesColumn(conn);
        if (col) {
          const [r2] = await conn.query(`SELECT ${col} AS cities_json FROM products WHERE id=? LIMIT 1`, [
            id,
          ]);
          const raw = r2?.[0]?.cities_json;
          if (raw != null && raw !== "") {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) cities = parsed;
            } catch {
              const s = String(raw || "");
              if (s.includes(",")) cities = s.split(",").map((x) => x.trim());
              else cities = [s].filter(Boolean);
            }
          }
        }
      } finally {
        conn.release();
      }
    } catch {}

    res.json({ ...product, images, ...(cities ? { cities } : {}) });
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Create (multipart) ----------------------------- */
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
      promo_discount_type,
      promo_discount_value,
      promo_free_delivery,

      sub_category_id,

      is_active,
      shop_id,
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      let finalShopId = null;
      const role = String(req.user?.role || "").toUpperCase();

      if (role === "VENDEUR") {
        const [[shop]] = await conn.query(`SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`, [
          req.user.id,
        ]);
        if (!shop) {
          conn.release();
          return res.status(400).json({ error: "Aucune boutique associée à ce vendeur" });
        }
        finalShopId = Number(shop.id);
      } else if (role === "ADMIN") {
        const sid = Number(shop_id) || 0;
        if (!sid) {
          conn.release();
          return res.status(400).json({ error: "shop_id requis pour la création par un admin" });
        }
        const [[shop]] = await conn.query(`SELECT id FROM shops WHERE id=? LIMIT 1`, [sid]);
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

      const resolvedSub = await resolveSubCategory(conn, { sub_category_id, category_id });
      if (!resolvedSub) {
        conn.release();
        return res.status(400).json({
          error: "sub_category_id invalide (ou ne correspond pas à category_id)",
        });
      }

      const duuminiRate = computeDuuminiRateFromSubCategorySlug(resolvedSub.slug);
      const active = parseBoolFlag(is_active, 1);

      const makeSlug = () =>
        (slug && String(slug).trim()) ||
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toLowerCase();

      const promoEligible = parseBoolFlag(promo_eligible, 0);
      let promoType = null;
      let promoValue = null;
      let promoFree = parseBoolFlag(promo_free_delivery, 0);

      if (promoEligible === 1) {
        promoType = normalizePromoType(promo_discount_type);
        const v = Number(promo_discount_value);
        promoValue = Number.isFinite(v) && v > 0 ? v : null;
        if (!promoValue) {
          promoType = null;
          promoValue = null;
        }
      } else {
        promoType = null;
        promoValue = null;
      }

      const citiesCol = await detectCitiesColumn(conn);
      const incomingCities = parseCitiesBody(req.body);
      const cities =
        incomingCities == null ? null : incomingCities.map(normalizeVilleFilter).filter(Boolean);
      const citiesJson = citiesCol && cities != null ? JSON.stringify(cities) : null;

      await conn.beginTransaction();

      let insertSql = `INSERT INTO products
        (shop_id, category_id, sub_category_id, name, slug, price, currency, description, stock, is_featured,
         promo_eligible, promo_discount_type, promo_discount_value, promo_free_delivery,
         duumini_rate, is_active`;

      const insertVals = [
        finalShopId,
        category_id ? Number(category_id) : null,
        resolvedSub.id,

        name,
        makeSlug(),
        Number(price),
        currency || "MAD",
        description || null,
        stock != null ? Number(stock) : 0,
        is_featured ? 1 : 0,

        promoEligible,
        promoType,
        promoValue,
        promoFree,

        duuminiRate,
        active,
      ];

      if (citiesCol && cities != null) {
        insertSql += `, ${citiesCol}`;
        insertVals.push(citiesJson);
      }

      insertSql += `) VALUES (${insertVals.map(() => "?").join(",")})`;

      const [r] = await conn.query(insertSql, insertVals);
      const productId = r.insertId;

      const files = Array.isArray(req.files) ? req.files : [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
        const up = await uploadBufferToCloudinary(f.buffer, f.originalname || undefined);
        const webUrl = up?.secure_url || up?.url;
        if (!webUrl) continue;
        await conn.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`, [
          productId,
          webUrl,
          i,
        ]);
      }

      await conn.commit();

      const channel = String(resolvedSub.slug || "").toLowerCase() === "food" ? "african-food" : "african-market";

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
    if (!id) return next();

    const {
      name,
      price,
      currency,
      description,
      stock,
      is_featured,

      promo_eligible,
      promo_discount_type,
      promo_discount_value,
      promo_free_delivery,

      sub_category_id,

      category_id,
      replace_images,
      is_active,
      shop_id,
    } = req.body || {};

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

      let newShopIdParam = null;
      if (shop_id != null && shop_id !== "") {
        const sid = Number(shop_id) || 0;
        if (sid > 0 && isAdmin(req.user)) {
          const [[shop]] = await conn.query(`SELECT id FROM shops WHERE id=? LIMIT 1`, [sid]);
          if (!shop) {
            conn.release();
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          newShopIdParam = sid;
        }
      }

      let resolvedSub = null;
      if (sub_category_id != null && sub_category_id !== "") {
        resolvedSub = await resolveSubCategory(conn, {
          sub_category_id,
          category_id: category_id ?? prod.category_id,
        });
        if (!resolvedSub) {
          conn.release();
          return res.status(400).json({
            error: "sub_category_id invalide (ou ne correspond pas à category_id)",
          });
        }
      } else {
        resolvedSub = null;
      }

      let duuminiRate = null;
      if (resolvedSub) duuminiRate = computeDuuminiRateFromSubCategorySlug(resolvedSub.slug);

      const active = parseBoolFlag(is_active, null);

      const promo = parsePromoFields({
        promo_eligible,
        promo_discount_type,
        promo_discount_value,
        promo_free_delivery,
      });

      await conn.query(
        `UPDATE products SET
           name                = COALESCE(?, name),
           price               = COALESCE(?, price),
           currency            = COALESCE(?, currency),
           description         = COALESCE(?, description),
           stock               = COALESCE(?, stock),
           is_featured         = COALESCE(?, is_featured),

           promo_eligible      = COALESCE(?, promo_eligible),
           promo_discount_type = CASE
                                  WHEN ? IS NULL THEN promo_discount_type
                                  WHEN ? = 1 THEN ?
                                  ELSE NULL
                                END,
           promo_discount_value = CASE
                                  WHEN ? IS NULL THEN promo_discount_value
                                  WHEN ? = 1 THEN ?
                                  ELSE NULL
                                END,
           promo_free_delivery = COALESCE(?, promo_free_delivery),

           sub_category_id     = COALESCE(?, sub_category_id),
           duumini_rate        = COALESCE(?, duumini_rate),

           is_active           = COALESCE(?, is_active),
           category_id         = COALESCE(?, category_id),
           shop_id             = COALESCE(?, shop_id)
         WHERE id=?`,
        [
          name ?? null,
          price != null ? Number(price) : null,
          currency ?? null,
          description ?? null,
          stock != null ? Number(stock) : null,
          is_featured === undefined ? null : is_featured ? 1 : 0,

          promo.promo_eligible,
          promo.promo_eligible,
          promo.promo_eligible,
          promo.promo_discount_type,
          promo.promo_eligible,
          promo.promo_eligible,
          promo.promo_discount_value,
          promo.promo_free_delivery,

          resolvedSub ? resolvedSub.id : null,
          duuminiRate,

          active,
          category_id != null ? Number(category_id) : null,
          newShopIdParam,
          id,
        ]
      );

      const citiesCol = await detectCitiesColumn(conn);
      const incomingCities = parseCitiesBody(req.body);
      if (citiesCol && incomingCities != null) {
        const cities = (incomingCities || []).map(normalizeVilleFilter).filter(Boolean);
        await conn.query(`UPDATE products SET ${citiesCol}=? WHERE id=?`, [JSON.stringify(cities), id]);
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        const doReplace = String(replace_images || "").toLowerCase() === "true";
        if (doReplace) {
          await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
        }
        const [[{ maxOrder }]] = await conn.query(
          `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder
             FROM product_images
            WHERE product_id=?`,
          [id]
        );
        let start = (maxOrder ?? -1) + 1;
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
          const up = await uploadBufferToCloudinary(f.buffer, f.originalname || undefined);
          const webUrl = up?.secure_url || up?.url;
          if (!webUrl) continue;
          await conn.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`, [
            id,
            webUrl,
            start + i,
          ]);
        }
      }

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
    if (!id) return next();

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
      for (const url of bodyImages) {
        const u = String(url || "").trim();
        if (!u) continue;
        await conn.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`, [
          id,
          u,
          order++,
        ]);
      }

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || !f.buffer || !f.mimetype?.startsWith("image/")) continue;
        const up = await uploadBufferToCloudinary(f.buffer, f.originalname || undefined);
        const webUrl = up?.secure_url || up?.url;
        if (!webUrl) continue;
        await conn.query(`INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`, [
          id,
          webUrl,
          order++,
        ]);
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
    if (!id) return next();

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

      for (const it of imgs) {
        const u = String(it.url || "");
        if (!u.startsWith("/uploads/")) continue;
        const abs = path.join(process.cwd(), u.replace(/^\//, "").replace(/\//g, path.sep));
        fs.promises.unlink(abs).catch(() => {});
      }

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
 *  Route de partage avec meta OG (inchangée chez toi)
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
  if (!id) return res.status(404).send("Not found");

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        p.id,
        p.slug,
        p.name,
        p.description,
        p.price,
        p.currency,
        p.is_active,
        s.name AS shop_name,
        s.city AS shop_city,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        sc.slug AS sub_category_slug,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      WHERE p.id = ?
      `,
      [id]
    );

    const product = rows[0];
    if (!product || !product.is_active) return res.status(404).send("Not found");

    const baseWeb =
      env.FRONT_WEB_BASE_URL || process.env.FRONT_WEB_BASE_URL || "https://www.duumini.com";

    const slugOrId = product.slug || product.id;
    const finalUrl = `${baseWeb}/products/${encodeURIComponent(slugOrId)}`;

    const sub = String(product.sub_category_slug || "").trim().toLowerCase();
    const channelPath = sub === "food" ? "/african-food" : "/african-market";

    const ogTitle = escapeHtml(
      `${product.name} — Duumini${product.shop_name ? ` (${product.shop_name})` : ""}`
    );

    const descriptionRaw = product.description || "Découvrez ce produit africain disponible sur Duumini.";
    const shortDesc = descriptionRaw.length > 180 ? descriptionRaw.slice(0, 177) + "..." : descriptionRaw;
    const ogDescription = escapeHtml(shortDesc);

    let ogImage = product.cover || product.shop_cover || product.shop_logo || null;

    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      if (ogImage.startsWith("/")) ogImage = `${baseWeb}${ogImage}`;
      else ogImage = `${baseWeb}/${ogImage}`;
    }
    if (!ogImage) ogImage = `${baseWeb}/images/share-default-product.jpg`;

    const priceAmount = Number(product.price || 0);
    const priceCurrency = product.currency || "MAD";

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      description: shortDesc,
      image: [ogImage],
      sku: String(product.id),
      brand: { "@type": "Brand", name: "Duumini" },
      offers: {
        "@type": "Offer",
        priceCurrency: priceCurrency,
        price: priceAmount,
        availability: "https://schema.org/InStock",
        url: finalUrl,
      },
      category: sub === "food" ? "African Food" : "African Market",
    };

    const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${ogTitle}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <link rel="canonical" href="${finalUrl}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="Duumini" />
    <meta property="og:locale" content="fr_FR" />
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:description" content="${ogDescription}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:url" content="${finalUrl}" />
    <meta property="product:price:amount" content="${priceAmount}" />
    <meta property="product:price:currency" content="${escapeHtml(priceCurrency)}" />
    <meta property="product:retailer_item_id" content="${product.id}" />
    <meta property="product:category" content="${escapeHtml(channelPath)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${ogTitle}" />
    <meta name="twitter:description" content="${ogDescription}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">
${JSON.stringify(jsonLd)}
    </script>
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

module.exports = router;
module.exports.shareRouter = shareRouter;
