// api/routes/products.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { getPool } = require("../lib/db");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const {
  authRequired,
  requireRole,
  isVendor,
  isAdmin,
} = require("../middlewares/auth");

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

function safeJsonParse(x, fallback = null) {
  if (x == null) return fallback;
  if (typeof x === "object") return x;
  try {
    return JSON.parse(String(x));
  } catch {
    return fallback;
  }
}

function normalizeVertical(value, fallback = null) {
  if (value == null) return fallback;
  const v = String(value || "").trim().toUpperCase();
  if (v === "FOOD" || v === "MARKET" || v === "FASHION") return v;
  return fallback;
}

function parseBoolQuery(req, key, defaultValue = 0) {
  const raw = req.query?.[key];
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

/* ============================
 *  Colonne cities (optionnelle)
 *  ⚠️ On ne filtre PLUS dessus, on la renvoie juste si elle existe.
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

function allowTrimList(arr) {
  const out = [];
  const seen = new Set();
  for (const it of arr || []) {
    const c = String(it || "").trim();
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
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

  const out = allowTrimList(arr);
  return out;
}

function normalizeCitiesValue(raw) {
  if (raw == null || raw === "") return null;

  if (Array.isArray(raw)) {
    const out = allowTrimList(raw);
    return out.length ? out : null;
  }

  const s = String(raw || "").trim();
  if (!s) return null;

  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        const out = allowTrimList(parsed);
        return out.length ? out : null;
      }
    } catch {}
  }

  if (s.includes(",")) {
    const out = allowTrimList(s.split(",").map((x) => x.trim()));
    return out.length ? out : null;
  }

  return [s];
}

let _citiesCol = null;
let _citiesColLoaded = false;

async function getCitiesColCached(pool) {
  if (_citiesColLoaded) return _citiesCol;
  const conn = await pool.getConnection();
  try {
    _citiesCol = await detectCitiesColumn(conn);
    _citiesColLoaded = true;
    return _citiesCol;
  } finally {
    conn.release();
  }
}

function withCities(rows, citiesCol) {
  if (!citiesCol) return rows;
  return (rows || []).map((r) => {
    const raw = r?.[citiesCol];
    const cities = normalizeCitiesValue(raw);
    if (!cities) return r;
    return { ...r, cities };
  });
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
    body?.promo_free_delivery === undefined
      ? null
      : parseBoolFlag(body?.promo_free_delivery, 0);

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

  let rate = computeDuuminiRateFromSubCategorySlug(row.sub_category_slug);

  if (duumini_rate != null) {
    const r = Number(duumini_rate);
    if (Number.isFinite(r) && r >= 0 && r <= 1) rate = r;
  }

  const clientPrice = Number(price || 0);
  const duuminiAmount = +(clientPrice * rate).toFixed(2);
  const vendorNet = +(clientPrice - duuminiAmount).toFixed(2);

  return { ...rest, price: clientPrice, vendor_price: vendorNet };
}

async function resolveSubCategory(conn, { sub_category_id, category_id }) {
  const sid = Number(sub_category_id) || 0;
  if (!sid) return null;

  if (category_id) {
    const cid = Number(category_id) || 0;
    const [rows] = await conn.query(
      `SELECT id, category_id, name, slug, vertical
         FROM sub_categories
        WHERE id=? AND category_id=?
        LIMIT 1`,
      [sid, cid]
    );
    return rows[0] || null;
  }

  const [rows] = await conn.query(
    `SELECT id, category_id, name, slug, vertical
       FROM sub_categories
      WHERE id=?
      LIMIT 1`,
    [sid]
  );
  return rows[0] || null;
}

/* ============================
 * Variants helpers
 * ============================ */

function normalizeSize(x) {
  const s = String(x ?? "").trim();
  return s ? s.slice(0, 20) : null;
}
function normalizeColor(x) {
  const s = String(x ?? "").trim();
  return s ? s.slice(0, 40) : null;
}
function normalizeSku(x) {
  const s = String(x ?? "").trim();
  return s ? s.slice(0, 80) : null;
}

function parseVariantsBody(body) {
  const raw =
    body?.variants ??
    body?.variantsJson ??
    body?.product_variants ??
    body?.productVariants ??
    null;

  const parsed = safeJsonParse(raw, null);
  if (!parsed || !Array.isArray(parsed)) return [];

  const out = [];
  for (const v of parsed) {
    if (!v || typeof v !== "object") continue;
    const size = normalizeSize(v.size);
    const color = normalizeColor(v.color);
    const sku = normalizeSku(v.sku);

    if (!size && !color) continue;

    const stockN = Number(v.stock);
    const stock =
      Number.isFinite(stockN) && stockN >= 0 ? Math.floor(stockN) : 0;

    const po =
      v.price_override == null || v.price_override === ""
        ? null
        : Number(v.price_override);
    const price_override = Number.isFinite(po) && po >= 0 ? po : null;

    const active =
      v.is_active === undefined ? 1 : parseBoolFlag(v.is_active, 1);

    out.push({
      size,
      color,
      sku,
      stock,
      price_override,
      is_active: active ?? 1,
    });
  }
  return out;
}

async function assertCanMutateProduct(conn, reqUser, productId) {
  const [[prod]] = await conn.query(
    `SELECT p.id, p.shop_id, p.vertical, s.owner_id
       FROM products p
       LEFT JOIN shops s ON s.id = p.shop_id
      WHERE p.id=? LIMIT 1`,
    [productId]
  );
  if (!prod) return { ok: false, status: 404, error: "Not found" };

  if (isVendor(reqUser) && String(prod.owner_id) !== String(reqUser.id)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, prod };
}

/* ============================
 * Listing: include variants (Fashion / opt-in)
 * ============================ */

async function attachVariantsToProducts(pool, items, opts = {}) {
  const include = !!opts.includeVariants;
  if (!include) return items;

  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return rows;

  const ids = rows.map((r) => Number(r.id)).filter(Boolean);
  if (!ids.length) return rows;

  const placeholders = ids.map(() => "?").join(",");
  const [vrows] = await pool.query(
    `SELECT id, product_id, size, color, sku, stock, price_override, is_active
       FROM product_variants
      WHERE product_id IN (${placeholders})
        AND is_active = 1
      ORDER BY product_id ASC, id ASC`,
    ids
  );

  const byPid = new Map();
  for (const v of vrows || []) {
    const pid = Number(v.product_id);
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(v);
  }

  return rows.map((p) => {
    const pid = Number(p.id);
    const variants = byPid.get(pid) || [];
    return {
      ...p,
      variants,
      variants_count: Number(p.variants_count || variants.length || 0),
      has_variants:
        p.has_variants !== undefined
          ? !!p.has_variants
          : Number(p.variants_count || variants.length || 0) > 0,
    };
  });
}

/**
 * Liste des produits (sans filtre ville)
 */
async function listProducts(pool, opts) {
  const {
    limit,
    offset,
    channel,
    onlyActive,
    onlyPromos,
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
  } = opts || {};

  const whereParts = [];
  const params = [];

  const v = normalizeVertical(vertical, null);
  if (v) {
    whereParts.push("p.vertical = ?");
    params.push(v);
  } else {
    if (channel === "african-food") {
      whereParts.push(`LOWER(TRIM(COALESCE(sc.slug,''))) = 'food'`);
    } else if (channel === "african-market") {
      whereParts.push(
        `(LOWER(TRIM(COALESCE(sc.slug,''))) <> 'food' OR sc.slug IS NULL)`
      );
    } else {
      whereParts.push("1=1");
    }
  }

  if (onlyActive) whereParts.push("p.is_active = 1");

  if (onlyPromos) {
    whereParts.push(
      `(p.promo_eligible = 1 AND COALESCE(p.promo_discount_value, 0) > 0)`
    );
  }

  const catId = Number(categoryId) || 0;
  if (catId) {
    whereParts.push("p.category_id = ?");
    params.push(catId);
  }

  const subId = Number(subCategoryId) || 0;
  if (subId) {
    whereParts.push("p.sub_category_id = ?");
    params.push(subId);
  }

  const shId = Number(shopId) || 0;
  if (shId) {
    whereParts.push("p.shop_id = ?");
    params.push(shId);
  }

  const qq = String(q || "").trim().toLowerCase();
  if (qq) {
    whereParts.push(
      `
      (
        LOWER(p.name) LIKE ?
        OR LOWER(COALESCE(p.description,'')) LIKE ?
        OR LOWER(COALESCE(s.name,'')) LIKE ?
      )
    `
    );
    const like = `%${qq}%`;
    params.push(like, like, like);
  }

  if (parseBoolFlag(onlyWithVariants, 0) === 1) {
    whereParts.push(
      `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1)`
    );
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
        LIMIT 1) AS cover,

      (SELECT COUNT(*)
         FROM product_variants pv
        WHERE pv.product_id = p.id AND pv.is_active = 1) AS variants_count,

      (SELECT MIN(COALESCE(pv.price_override, p.price))
         FROM product_variants pv
        WHERE pv.product_id = p.id AND pv.is_active = 1) AS min_price

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

  let rows = rowsRaw.map((r) => {
    const base = stripDuuminiRateFromProduct(r);
    const variants_count = Number(r.variants_count || 0);
    const min_price =
      r.min_price == null || r.min_price === "" ? null : Number(r.min_price ?? 0);
    return {
      ...base,
      has_variants: variants_count > 0,
      min_price: Number.isFinite(min_price) ? min_price : null,
      variants_count,
    };
  });

  rows = await attachVariantsToProducts(pool, rows, {
    includeVariants: !!includeVariants,
  });

  return { rows, total };
}

/* ----------------------------- Listing ----------------------------- */

function parseOnlyActive(req) {
  const onlyActiveRaw = String(req.query.onlyActive || "").toLowerCase();
  return (
    onlyActiveRaw === "1" ||
    onlyActiveRaw === "true" ||
    onlyActiveRaw === "yes" ||
    onlyActiveRaw === "on"
  );
}

function pickFilters(req) {
  return {
    categoryId: req.query.categoryId ?? req.query.category_id ?? null,
    subCategoryId: req.query.subCategoryId ?? req.query.sub_category_id ?? null,
    shopId: req.query.shopId ?? req.query.shop_id ?? null,
    q: req.query.q ?? "",
    vertical: req.query.vertical ?? req.query.v ?? null,
    includeVariants: parseBoolQuery(req, "includeVariants", 0),
    onlyWithVariants: parseBoolQuery(req, "onlyWithVariants", 0),
  };
}

async function listHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActive = parseOnlyActive(req);
  const {
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
  } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

    const v = normalizeVertical(vertical, null);
    const include = includeVariants === 1 ? true : v === "FASHION" ? true : false;

    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      onlyActive,
      onlyPromos: false,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical,
      includeVariants: include,
      onlyWithVariants,
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function listFoodHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActive = parseOnlyActive(req);
  const { categoryId, subCategoryId, shopId, q } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-food",
      onlyActive,
      onlyPromos: false,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical: null,
      includeVariants: false,
      onlyWithVariants: 0,
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function listMarketHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const onlyActive = parseOnlyActive(req);
  const { categoryId, subCategoryId, shopId, q } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);
    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-market",
      onlyActive,
      onlyPromos: false,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical: null,
      includeVariants: false,
      onlyWithVariants: 0,
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

router.get("/fashion", async (req, res, next) => {
  req.query.vertical = "FASHION";
  if (req.query.includeVariants == null) req.query.includeVariants = "1";
  return listHandler(req, res, next);
});

router.get("/", listHandler);
router.get("/african-food", listFoodHandler);
router.get("/african-market", listMarketHandler);

/* ----------------------------- Promotions list ----------------------------- */
router.get("/promotions", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 12);
  const onlyActive = parseOnlyActive(req);

  const channel = String(req.query.channel || "all").toLowerCase();
  const channelNorm =
    channel === "african-food"
      ? "african-food"
      : channel === "african-market"
      ? "african-market"
      : null;

  const { categoryId, subCategoryId, shopId, q, vertical, includeVariants } =
    pickFilters(req);

  try {
    const citiesCol = await getCitiesColCached(pool);

    const { rows } = await listProducts(pool, {
      limit,
      offset: 0,
      channel: channelNorm,
      onlyActive,
      onlyPromos: true,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical,
      includeVariants:
        includeVariants === 1 && normalizeVertical(vertical, null) === "FASHION",
      onlyWithVariants: 0,
    });

    res.json(withCities(rows, citiesCol).slice(0, limit));
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : plus commandés ----------------------------- */
router.get("/top-ordered", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);

  try {
    const citiesCol = await getCitiesColCached(pool);

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
      GROUP BY p.id
      ORDER BY total_qty DESC
      LIMIT ?
      `,
      [limit]
    );

    res.json(withCities(rowsRaw.map(stripDuuminiRateFromProduct), citiesCol));
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Top produits : mieux notés ----------------------------- */
router.get("/top-rated", async (req, res, next) => {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const minCount = toPositiveInt(req.query.minCount, 2);

  try {
    const citiesCol = await getCitiesColCached(pool);

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
        AVG(r.rating) AS avg_rating,
        COUNT(r.id)   AS rating_count
      FROM product_ratings r
      JOIN products p ON p.id = r.product_id AND p.is_active = 1
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      GROUP BY p.id
      HAVING rating_count >= ?
      ORDER BY avg_rating DESC, rating_count DESC
      LIMIT ?
      `,
      [minCount, limit]
    );

    res.json(withCities(rowsRaw.map(stripDuuminiRateFromProduct), citiesCol));
  } catch (e) {
    next(e);
  }
});

/* =======================================================================
 * VARIANTS API
 * ======================================================================= */

// GET variants for a product
router.get("/:id/variants", async (req, res, next) => {
  const productId = parseIdParam(req.params.id);
  if (!productId) return next();

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, product_id, size, color, sku, stock, price_override, is_active, created_at, updated_at
         FROM product_variants
        WHERE product_id=?
        ORDER BY is_active DESC, id ASC`,
      [productId]
    );
    res.json(rows || []);
  } catch (e) {
    next(e);
  }
});

// PUT one variant
router.put(
  "/variants/:variantId",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  express.json(),
  async (req, res, next) => {
    const variantId = parseIdParam(req.params.variantId);
    if (!variantId) return next();

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[v]] = await conn.query(
        `SELECT pv.*, p.shop_id, s.owner_id
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE pv.id=? LIMIT 1`,
        [variantId]
      );
      if (!v) return res.status(404).json({ error: "Not found" });
      if (isVendor(req.user) && String(v.owner_id) !== String(req.user.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const size =
        req.body?.size === undefined ? null : normalizeSize(req.body.size);
      const color =
        req.body?.color === undefined ? null : normalizeColor(req.body.color);
      const sku =
        req.body?.sku === undefined ? null : normalizeSku(req.body.sku);

      const stock =
        req.body?.stock === undefined
          ? null
          : Number.isFinite(Number(req.body.stock)) &&
            Number(req.body.stock) >= 0
          ? Math.floor(Number(req.body.stock))
          : 0;

      const po =
        req.body?.price_override === undefined
          ? null
          : req.body.price_override == null || req.body.price_override === ""
          ? null
          : Number(req.body.price_override);
      const price_override =
        po == null ? null : Number.isFinite(po) && po >= 0 ? po : null;

      const active =
        req.body?.is_active === undefined
          ? null
          : parseBoolFlag(req.body.is_active, 1);

      await conn.query(
        `UPDATE product_variants SET
           size = COALESCE(?, size),
           color = COALESCE(?, color),
           sku = COALESCE(?, sku),
           stock = COALESCE(?, stock),
           price_override = CASE WHEN ? IS NULL THEN price_override ELSE ? END,
           is_active = COALESCE(?, is_active)
         WHERE id=?`,
        [
          size,
          color,
          sku,
          stock,
          po === undefined ? null : 1,
          price_override,
          active,
          variantId,
        ]
      );

      res.json({ ok: true });
    } catch (e) {
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate variant (size+color)" });
      }
      next(e);
    } finally {
      conn.release();
    }
  }
);

// DELETE one variant
router.delete(
  "/variants/:variantId",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  async (req, res, next) => {
    const variantId = parseIdParam(req.params.variantId);
    if (!variantId) return next();

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[v]] = await conn.query(
        `SELECT pv.id, pv.product_id, s.owner_id
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE pv.id=? LIMIT 1`,
        [variantId]
      );
      if (!v) return res.status(404).json({ error: "Not found" });
      if (isVendor(req.user) && String(v.owner_id) !== String(req.user.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await conn.query(`DELETE FROM product_variants WHERE id=?`, [variantId]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

// POST bulk variants for a product (replace or upsert)
router.post(
  "/:id/variants",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  express.json(),
  async (req, res, next) => {
    const productId = parseIdParam(req.params.id);
    if (!productId) return next();

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const auth = await assertCanMutateProduct(conn, req.user, productId);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

      const replace =
        parseBoolFlag(req.query.replace ?? req.body?.replace, 0) === 1;

      const variants = parseVariantsBody(req.body);
      if (!variants.length) {
        return res.status(400).json({ error: "variants requis (array JSON)" });
      }

      await conn.beginTransaction();

      if (replace) {
        await conn.query(`DELETE FROM product_variants WHERE product_id=?`, [
          productId,
        ]);
      }

      for (const v of variants) {
        await conn.query(
          `
          INSERT INTO product_variants (product_id, size, color, sku, stock, price_override, is_active)
          VALUES (?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            sku = VALUES(sku),
            stock = VALUES(stock),
            price_override = VALUES(price_override),
            is_active = VALUES(is_active)
          `,
          [
            productId,
            v.size,
            v.color,
            v.sku,
            v.stock,
            v.price_override,
            v.is_active ?? 1,
          ]
        );
      }

      await conn.commit();

      const [rows] = await conn.query(
        `SELECT id, product_id, size, color, sku, stock, price_override, is_active, created_at, updated_at
           FROM product_variants
          WHERE product_id=?
          ORDER BY is_active DESC, id ASC`,
        [productId]
      );

      res.status(201).json({ ok: true, items: rows || [] });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate variant (size+color)" });
      }
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Read one by SLUG (✅ NEW) ----------------------------- */
// Ton ProductView appelle /api/products/slug/:slug => on l'ajoute.
router.get("/slug/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) return next();

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

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
         sc.slug AS sub_category_slug,

         (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS variants_count,
         (SELECT MIN(COALESCE(pv.price_override, p.price))
            FROM product_variants pv
           WHERE pv.product_id = p.id AND pv.is_active = 1) AS min_price

       FROM products p
       LEFT JOIN shops s ON s.id = p.shop_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
       WHERE LOWER(TRIM(p.slug))=? LIMIT 1`,
      [slug]
    );

    const rawProduct = rows[0];
    if (!rawProduct) return res.status(404).json({ error: "Not found" });

    const product = stripDuuminiRateFromProduct(rawProduct);

    const [images] = await pool.query(
      `SELECT id, url, sort_order
         FROM product_images
        WHERE product_id=?
        ORDER BY sort_order ASC, id ASC`,
      [rawProduct.id]
    );

    const wantVariants =
      String(req.query.variants || "").toLowerCase() === "1" ||
      String(req.query.variants || "").toLowerCase() === "true";

    let variants = undefined;
    if (wantVariants) {
      const [vrows] = await pool.query(
        `SELECT id, product_id, size, color, sku, stock, price_override, is_active
           FROM product_variants
          WHERE product_id=?
          ORDER BY is_active DESC, id ASC`,
        [rawProduct.id]
      );
      variants = vrows || [];
    }

    let cities = null;
    if (citiesCol) cities = normalizeCitiesValue(rawProduct?.[citiesCol]);

    const variants_count = Number(rawProduct.variants_count || 0);
    const min_price =
      rawProduct.min_price == null || rawProduct.min_price === ""
        ? null
        : Number(rawProduct.min_price);

    res.json({
      ...product,
      images,
      has_variants: variants_count > 0,
      min_price: Number.isFinite(min_price) ? min_price : null,
      ...(variants ? { variants } : {}),
      ...(cities ? { cities } : {}),
    });
  } catch (e) {
    next(e);
  }
});

/* ----------------------------- Read one by ID ----------------------------- */
router.get("/:id", async (req, res, next) => {
  const id = parseIdParam(req.params.id);
  if (!id) return next();

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

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
         sc.slug AS sub_category_slug,

         (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS variants_count,
         (SELECT MIN(COALESCE(pv.price_override, p.price))
            FROM product_variants pv
           WHERE pv.product_id = p.id AND pv.is_active = 1) AS min_price

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

    const wantVariants =
      String(req.query.variants || "").toLowerCase() === "1" ||
      String(req.query.variants || "").toLowerCase() === "true";

    let variants = undefined;
    if (wantVariants) {
      const [vrows] = await pool.query(
        `SELECT id, product_id, size, color, sku, stock, price_override, is_active
           FROM product_variants
          WHERE product_id=?
          ORDER BY is_active DESC, id ASC`,
        [id]
      );
      variants = vrows || [];
    }

    let cities = null;
    if (citiesCol) cities = normalizeCitiesValue(rawProduct?.[citiesCol]);

    const variants_count = Number(rawProduct.variants_count || 0);
    const min_price =
      rawProduct.min_price == null || rawProduct.min_price === ""
        ? null
        : Number(rawProduct.min_price);

    res.json({
      ...product,
      images,
      has_variants: variants_count > 0,
      min_price: Number.isFinite(min_price) ? min_price : null,
      ...(variants ? { variants } : {}),
      ...(cities ? { cities } : {}),
    });
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

      vertical,
      variants,
      replace_variants,
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const citiesCol = await getCitiesColCached(pool);

      let finalShopId = null;
      const role = String(req.user?.role || "").toUpperCase();

      if (role === "VENDEUR") {
        const [[shop]] = await conn.query(
          `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
          [req.user.id]
        );
        if (!shop) {
          return res
            .status(400)
            .json({ error: "Aucune boutique associée à ce vendeur" });
        }
        finalShopId = Number(shop.id);
      } else if (role === "ADMIN") {
        const sid = Number(shop_id) || 0;
        if (!sid) {
          return res
            .status(400)
            .json({ error: "shop_id requis pour la création par un admin" });
        }
        const [[shop]] = await conn.query(
          `SELECT id FROM shops WHERE id=? LIMIT 1`,
          [sid]
        );
        if (!shop) {
          return res.status(400).json({ error: "Boutique invalide (shop_id)" });
        }
        finalShopId = sid;
      } else {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (!name || price == null) {
        return res.status(400).json({ error: "name et price requis" });
      }

      const resolvedSub = await resolveSubCategory(conn, {
        sub_category_id,
        category_id,
      });
      if (!resolvedSub) {
        return res.status(400).json({
          error: "sub_category_id invalide (ou ne correspond pas à category_id)",
        });
      }

      const incomingVertical = normalizeVertical(vertical, null);
      const fallbackVertical =
        String(resolvedSub.slug || "").toLowerCase() === "food"
          ? "FOOD"
          : "MARKET";
      const finalVertical = incomingVertical || fallbackVertical;

      const duuminiRate = computeDuuminiRateFromSubCategorySlug(resolvedSub.slug);
      const active = parseBoolFlag(is_active, 1);

      const makeSlug = () =>
        (slug && String(slug).trim()) ||
        `${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 7)}`.toLowerCase();

      const promo = parsePromoFields({
        promo_eligible,
        promo_discount_type,
        promo_discount_value,
        promo_free_delivery,
      });

      const incomingCities = parseCitiesBody(req.body);
      const cities = incomingCities == null ? null : incomingCities;
      const citiesJson =
        citiesCol && cities != null ? JSON.stringify(cities) : null;

      const variantsList = parseVariantsBody({ variants });
      const replace = parseBoolFlag(replace_variants, 0) === 1;

      await conn.beginTransaction();

      let insertSql = `INSERT INTO products
        (shop_id, category_id, sub_category_id, name, slug, price, currency, description, stock, is_featured,
         promo_eligible, promo_discount_type, promo_discount_value, promo_free_delivery,
         duumini_rate, is_active, vertical`;

      const promoEligibleFinal =
        promo.promo_mode === "UNTOUCHED" ? 0 : promo.promo_eligible ?? 0;

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
        promoEligibleFinal,
        promo.promo_mode === "ON" ? promo.promo_discount_type : null,
        promo.promo_mode === "ON" ? promo.promo_discount_value : null,
        promo.promo_free_delivery ?? 0,
        duuminiRate,
        active,
        finalVertical,
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

      if (variantsList.length) {
        if (replace) {
          await conn.query(`DELETE FROM product_variants WHERE product_id=?`, [
            productId,
          ]);
        }
        for (const v of variantsList) {
          await conn.query(
            `
            INSERT INTO product_variants (product_id, size, color, sku, stock, price_override, is_active)
            VALUES (?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE
              sku = VALUES(sku),
              stock = VALUES(stock),
              price_override = VALUES(price_override),
              is_active = VALUES(is_active)
            `,
            [
              productId,
              v.size,
              v.color,
              v.sku,
              v.stock,
              v.price_override,
              v.is_active ?? 1,
            ]
          );
        }
      }

      await conn.commit();

      const channel =
        String(resolvedSub.slug || "").toLowerCase() === "food"
          ? "african-food"
          : "african-market";

      try {
        const [userRows] = await pool.query(
          `SELECT DISTINCT user_id FROM user_devices WHERE provider = 'pushy'`
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

      try {
        const { getIO, emitToShops } = require("../ws");
        const io = getIO && getIO();
        if (io && emitToShops && finalShopId != null) {
          emitToShops([finalShopId], "product:created", { product_id: productId });
        }
      } catch {}

      res.status(201).json({ id: productId, channel, vertical: finalVertical });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate slug" });
      }
      if (e && e.code === "ER_NO_REFERENCED_ROW_2") {
        return res
          .status(400)
          .json({ error: "FK invalid (category/sub_category?)" });
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

      vertical,
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const citiesCol = await getCitiesColCached(pool);

      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id
           FROM products p
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE p.id=?`,
        [id]
      );
      if (!prod) return res.status(404).json({ error: "Not found" });

      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let newShopIdParam = null;
      if (shop_id != null && shop_id !== "") {
        const sid = Number(shop_id) || 0;
        if (sid > 0 && isAdmin(req.user)) {
          const [[shop]] = await conn.query(
            `SELECT id FROM shops WHERE id=? LIMIT 1`,
            [sid]
          );
          if (!shop)
            return res
              .status(400)
              .json({ error: "Boutique invalide (shop_id)" });
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
          return res.status(400).json({
            error: "sub_category_id invalide (ou ne correspond pas à category_id)",
          });
        }
      }

      let duuminiRate = null;
      if (resolvedSub)
        duuminiRate = computeDuuminiRateFromSubCategorySlug(resolvedSub.slug);

      const active = parseBoolFlag(is_active, null);

      const promo = parsePromoFields({
        promo_eligible,
        promo_discount_type,
        promo_discount_value,
        promo_free_delivery,
      });

      const vert = normalizeVertical(vertical, null);

      await conn.query(
        `UPDATE products SET
           name                = COALESCE(?, name),
           price               = COALESCE(?, price),
           currency            = COALESCE(?, currency),
           description         = COALESCE(?, description),
           stock               = COALESCE(?, stock),
           is_featured         = COALESCE(?, is_featured),

           promo_eligible       = COALESCE(?, promo_eligible),
           promo_discount_type  = CASE
                                   WHEN ? IS NULL THEN promo_discount_type
                                   WHEN ? = 1 THEN ?
                                   ELSE NULL
                                 END,
           promo_discount_value = CASE
                                   WHEN ? IS NULL THEN promo_discount_value
                                   WHEN ? = 1 THEN ?
                                   ELSE NULL
                                 END,
           promo_free_delivery  = COALESCE(?, promo_free_delivery),

           sub_category_id     = COALESCE(?, sub_category_id),
           duumini_rate        = COALESCE(?, duumini_rate),

           is_active           = COALESCE(?, is_active),
           category_id         = COALESCE(?, category_id),
           shop_id             = COALESCE(?, shop_id),
           vertical            = COALESCE(?, vertical)

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
          vert,

          id,
        ]
      );

      const incomingCities = parseCitiesBody(req.body);
      if (citiesCol && incomingCities != null) {
        const cities = allowTrimList(incomingCities || []);
        await conn.query(`UPDATE products SET ${citiesCol}=? WHERE id=?`, [
          JSON.stringify(cities),
          id,
        ]);
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        const doReplace =
          String(replace_images || "").toLowerCase() === "true" ||
          String(replace_images || "").toLowerCase() === "1" ||
          String(replace_images || "").toLowerCase() === "yes";

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
      if (!prod) return res.status(404).json({ error: "Not found" });

      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
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
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [id, u, order++]
        );
      }

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
      if (!prod) return res.status(404).json({ error: "Not found" });

      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
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
        const abs = path.join(
          process.cwd(),
          u.replace(/^\//, "").replace(/\//g, path.sep)
        );
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
 *  Route de partage avec meta OG (✅ FIX)
 *  - redirect vers la VRAIE route front: /products/:idOrSlug
 *  - og:image : si /uploads => base API (pas baseWeb)
 *  - no-store pour éviter cache WhatsApp/FB
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
    const citiesCol = await getCitiesColCached(pool);

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
        p.vertical,

        s.name AS shop_name,
        s.city AS shop_city,
        s.logo AS shop_logo,
        s.cover AS shop_cover,

        c.name AS category_name,
        c.slug AS category_slug,

        sc.slug AS sub_category_slug,

        ${citiesCol ? `p.${citiesCol} AS cities_raw,` : ""}

        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY sort_order ASC, id ASC
          LIMIT 1) AS cover
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      WHERE p.id = ?
      `,
      [id]
    );

    const product = rows[0];
    if (!product || !product.is_active) return res.status(404).send("Not found");

    const baseWeb =
      env.FRONT_WEB_BASE_URL ||
      process.env.FRONT_WEB_BASE_URL ||
      "https://www.duumini.com";

    // ✅ base publique API (pour /uploads/…)
    const apiBase =
      env.API_PUBLIC_ORIGIN ||
      process.env.API_PUBLIC_ORIGIN ||
      "https://duumini-api.onrender.com";

    // ✅ IMPORTANT: ton front est /products/:idOrSlug
    const finalUrl = `${baseWeb}/products/${encodeURIComponent(product.id)}`;

    const sub = String(product.sub_category_slug || "").trim().toLowerCase();
    const channelPath = sub === "food" ? "/african-food" : "/african-market";

    const ogTitle = escapeHtml(
      `${product.name} — Duumini${
        product.shop_name ? ` (${product.shop_name})` : ""
      }`
    );

    const descriptionRaw =
      product.description ||
      "Découvrez ce produit africain disponible sur Duumini.";
    const shortDesc =
      descriptionRaw.length > 180
        ? descriptionRaw.slice(0, 177) + "..."
        : descriptionRaw;
    const ogDescription = escapeHtml(shortDesc);

    // ✅ og:image : si URL relative => base selon le cas
    let ogImage = product.cover || product.shop_cover || product.shop_logo || null;
    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      const base = String(ogImage).startsWith("/uploads") ? apiBase : baseWeb;
      ogImage = String(ogImage).startsWith("/")
        ? `${base}${ogImage}`
        : `${base}/${ogImage}`;
    }
    if (!ogImage) ogImage = `${baseWeb}/images/share-default-product.jpg`;

    const priceAmount = Number(product.price || 0);
    const priceCurrency = product.currency || "MAD";

    let cities = null;
    if (citiesCol) cities = normalizeCitiesValue(product?.cities_raw);

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
      category:
        product.vertical === "FASHION"
          ? "Fashion & Style"
          : sub === "food"
          ? "African Food"
          : "African Market",
      ...(cities?.length ? { areaServed: cities } : {}),
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
    <meta property="product:price:currency" content="${escapeHtml(
      priceCurrency
    )}" />
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

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(html);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.shareRouter = shareRouter;
