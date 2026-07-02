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
  isRestaurant,
} = require("../middlewares/auth");

const cloudinary = require("cloudinary").v2;
const { env } = require("../lib/env");

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

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
const upload = multer({ storage: multer.memoryStorage() });

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

function parseBoolQuery(req, key, defaultValue = 0) {
  const raw = req.query?.[key];
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return 1;
  if (v === "0" || v === "false" || v === "no" || v === "off") return 0;
  return defaultValue;
}

function parseVariantsQuery(req) {
  return parseBoolQuery(req, "variants", 0) === 1;
}

function normalizeVertical(value, fallback = null) {
  if (value == null) return fallback;

  const raw = String(value || "").trim();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const v = noAccent.trim().toUpperCase();

  if (v === "FOOD") return "FOOD";
  if (v === "MARKET" || v === "MARCHE" || v === "MARCHÉ") return "MARKET";
  if (v === "FASHION") return "FASHION";
  return fallback;
}

function parseActiveFilter(req, defaultValue = null) {
  const raw = req.query?.onlyActive;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }

  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return 1;
  if (["0", "false", "no", "off"].includes(v)) return 0;
  return defaultValue;
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
    onlyDrinks: parseBoolQuery(req, "onlyDrinks", 0),
    excludeDrinks: parseBoolQuery(req, "excludeDrinks", 0),
    onlyPromos: parseBoolQuery(req, "onlyPromos", 0),
  };
}

function actingUserId(req) {
  const u = req?.user || null;
  const id = Number(u?.effective_user_id || u?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function actingShopId(req) {
  const u = req?.user || null;
  const id = Number(u?.effective_shop_id || u?.impersonate_shop_id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isActingVendorOrRestaurant(req) {
  return isVendor(req?.user) || isRestaurant(req?.user);
}

const PRODUCTS_CACHE_ENABLED =
  String(env.PRODUCTS_CACHE_ENABLED ?? "1").trim() === "1";
const PRODUCTS_CACHE_TTL_MS = toPositiveInt(env.PRODUCTS_CACHE_TTL_MS, 20_000);
const PRODUCTS_CACHE_MAX = toPositiveInt(env.PRODUCTS_CACHE_MAX, 500);

const _cache = new Map();

function _cacheNow() {
  return Date.now();
}

function _cachePrune() {
  const now = _cacheNow();
  for (const [k, v] of _cache.entries()) {
    if (!v || v.exp <= now) _cache.delete(k);
  }
  if (_cache.size <= PRODUCTS_CACHE_MAX) return;
  const it = _cache.keys();
  while (_cache.size > PRODUCTS_CACHE_MAX) {
    const k = it.next().value;
    if (k == null) break;
    _cache.delete(k);
  }
}

function cacheGet(key) {
  if (!PRODUCTS_CACHE_ENABLED) return null;
  const item = _cache.get(key);
  if (!item) return null;
  if (item.exp <= _cacheNow()) {
    _cache.delete(key);
    return null;
  }
  return item.payload ?? null;
}

function cacheSet(key, payload, ttlMs = PRODUCTS_CACHE_TTL_MS) {
  if (!PRODUCTS_CACHE_ENABLED) return;
  _cachePrune();
  _cache.set(key, { exp: _cacheNow() + Math.max(1000, ttlMs), payload });
}

function clearProductsCache() {
  _cache.clear();
}

function buildCacheKey(req, scope = "PUBLIC") {
  const q = req.query || {};
  const base = `${req.method}:${req.baseUrl}${req.path}`;
  const stableKeys = Object.keys(q).sort();
  const queryStr = stableKeys.map((k) => `${k}=${String(q[k])}`).join("&");

  if (scope === "PUBLIC") return `PUBLIC|${base}?${queryStr}`;

  const uid = actingUserId(req) || 0;
  const role = String(req?.user?.role || "").toUpperCase();
  const shop = actingShopId(req) || 0;
  return `AUTH|uid=${uid}|role=${role}|shop=${shop}|${base}?${queryStr}`;
}

function cachedJson(scope, ttlMs) {
  return (req, res, next) => {
    if (!PRODUCTS_CACHE_ENABLED) return next();

    const noCache = String(req.query?.noCache ?? "").toLowerCase();
    if (noCache === "1" || noCache === "true" || noCache === "yes") {
      return next();
    }

    const key = buildCacheKey(req, scope);
    const cached = cacheGet(key);
    if (cached != null) return res.json(cached);

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheSet(key, body, ttlMs);
      }
      return originalJson(body);
    };

    return next();
  };
}

const DRINK_CATEGORY_SLUG = "boissons";
const DRINK_CATEGORY_ID_FALLBACK = 8;

let _drinkCatLoaded = false;
let _drinkCatId = DRINK_CATEGORY_ID_FALLBACK;

async function getDrinkCategoryIdCached(pool) {
  if (_drinkCatLoaded) return _drinkCatId;

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id FROM categories WHERE LOWER(TRIM(slug))=? LIMIT 1`,
      [DRINK_CATEGORY_SLUG]
    );
    const id = Number(rows?.[0]?.id || 0);
    _drinkCatId = id > 0 ? id : DRINK_CATEGORY_ID_FALLBACK;
    _drinkCatLoaded = true;
    return _drinkCatId;
  } finally {
    conn.release();
  }
}

function isDrinkCategoryId(catId, drinkCatId) {
  const c = Number(catId || 0);
  const d = Number(drinkCatId || 0);
  return !!c && !!d && c === d;
}

let _supplierMetaLoaded = false;
let _supplierMeta = {
  enabled: false,
  costCol: null,
  stockCol: null,
  updatedAtCol: null,
};

async function tableExists(conn, tableName) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS c
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [tableName]
  );
  return Number(row?.c || 0) > 0;
}

async function detectSupplierMeta(conn) {
  const enabled = await tableExists(conn, "supplier_products");
  if (!enabled) {
    return {
      enabled: false,
      costCol: null,
      stockCol: null,
      updatedAtCol: null,
    };
  }

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'supplier_products'`
  );

  const names = new Set((cols || []).map((c) => String(c.COLUMN_NAME || "")));

  const costCandidates = ["cost_price", "buy_price", "purchase_price", "unit_cost"];
  const stockCandidates = ["stock", "qty", "quantity", "qty_in_stock", "remaining_qty"];
  const updatedCandidates = ["updated_at", "created_at", "last_supply_at"];

  const costCol = costCandidates.find((c) => names.has(c)) || null;
  const stockCol = stockCandidates.find((c) => names.has(c)) || null;
  const updatedAtCol = updatedCandidates.find((c) => names.has(c)) || null;

  return { enabled: true, costCol, stockCol, updatedAtCol };
}

async function getSupplierMetaCached(pool) {
  if (_supplierMetaLoaded) return _supplierMeta;
  const conn = await pool.getConnection();
  try {
    _supplierMeta = await detectSupplierMeta(conn);
    _supplierMetaLoaded = true;
    return _supplierMeta;
  } finally {
    conn.release();
  }
}

function supplierAggSelect(meta) {
  if (!meta?.enabled) return { joinSql: "", selectSql: "" };

  const costCol = meta.costCol;
  const stockCol = meta.stockCol;
  const updatedAtCol = meta.updatedAtCol;

  const costExpr = costCol ? `MIN(${costCol})` : "NULL";
  const stockExpr = stockCol ? `COALESCE(SUM(${stockCol}),0)` : "NULL";
  const lastExpr = updatedAtCol ? `MAX(${updatedAtCol})` : "NULL";

  return {
    joinSql: `
      LEFT JOIN (
        SELECT
          product_id,
          ${stockExpr} AS supplier_stock,
          ${costExpr}  AS supplier_cost,
          ${lastExpr}  AS supplier_last_supply_at
        FROM supplier_products
        GROUP BY product_id
      ) sp ON sp.product_id = p.id
    `,
    selectSql: `,
      sp.supplier_stock,
      sp.supplier_cost,
      sp.supplier_last_supply_at
    `,
  };
}

function addSupplierAggToRow(row) {
  if (!row) return row;
  if (!Object.prototype.hasOwnProperty.call(row, "supplier_stock")) {
    row.supplier_stock = null;
  }
  if (!Object.prototype.hasOwnProperty.call(row, "supplier_cost")) {
    row.supplier_cost = null;
  }
  if (!Object.prototype.hasOwnProperty.call(row, "supplier_last_supply_at")) {
    row.supplier_last_supply_at = null;
  }
  return row;
}

let _shopTypeColLoaded = false;
let _shopTypeCol = null;

async function detectShopTypeColumn(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shops'
        AND COLUMN_NAME = 'shop_type'
      LIMIT 1`
  );
  return rows?.length ? "shop_type" : null;
}

async function getShopTypeColCached(pool) {
  if (_shopTypeColLoaded) return _shopTypeCol;
  const conn = await pool.getConnection();
  try {
    _shopTypeCol = await detectShopTypeColumn(conn);
    _shopTypeColLoaded = true;
    return _shopTypeCol;
  } finally {
    conn.release();
  }
}

function normalizeShopType(x) {
  const v = String(x || "").trim().toUpperCase();
  if (!v) return null;
  if (v === "VENDOR" || v === "VENDEUR" || v === "SHOP") return "VENDOR";
  if (v === "SUPPLIER" || v === "FOURNISSEUR") return "SUPPLIER";
  if (v === "RESTAURANT") return "RESTAURANT";
  return v;
}

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

  return allowTrimList(arr);
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

function computePromoPrice(basePrice, promoEligible, type, value) {
  const base = Number(basePrice || 0);
  if (!promoEligible) return null;

  const v = Number(value);
  if (!Number.isFinite(base) || base <= 0) return null;
  if (!Number.isFinite(v) || v <= 0) return null;

  const t = String(type || "").toUpperCase();
  let out = base;

  if (t === "AMOUNT") out = base - v;
  else if (t === "PERCENT") out = base * (1 - v / 100);
  else out = base * (1 - v / 100);

  if (!Number.isFinite(out)) return null;
  if (out < 0) out = 0;

  return +out.toFixed(2);
}

function withPromoComputed(p) {
  if (!p) return p;

  const promo_price = computePromoPrice(
    p.price,
    Number(p.promo_eligible) === 1,
    p.promo_discount_type,
    p.promo_discount_value
  );

  const min_promo_price =
    p.min_price != null
      ? computePromoPrice(
          p.min_price,
          Number(p.promo_eligible) === 1,
          p.promo_discount_type,
          p.promo_discount_value
        )
      : null;

  return {
    ...p,
    promo_price,
    min_promo_price,
    has_promo: promo_price != null,
  };
}

function computeDefaultDuuminiRate(row) {
  const v = String(row?.vertical || "").trim().toUpperCase();
  if (v === "FOOD") return 0.18;
  return 0.11;
}

function stripDuuminiRateFromProduct(row) {
  if (!row) return row;

  const { duumini_rate, price, ...rest } = row;

  let rate = computeDefaultDuuminiRate(row);

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

  const actingId = Number(reqUser?.effective_user_id || reqUser?.id || 0);

  if (isVendor(reqUser) || isRestaurant(reqUser)) {
    if (String(prod.owner_id) !== String(actingId)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
  }

  return { ok: true, prod };
}

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

async function getSelectMeta(pool) {
  const shopTypeCol = await getShopTypeColCached(pool);
  const supplierMeta = await getSupplierMetaCached(pool);
  const supplierAgg = supplierAggSelect(supplierMeta);
  return { shopTypeCol, supplierAgg };
}

function baseSelectSql(shopTypeCol, supplierAgg) {
  return `
    SELECT
      p.*,
      s.name AS shop_name,
      s.logo AS shop_logo,
      s.cover AS shop_cover,
      s.city AS shop_city
      ${shopTypeCol ? `, s.${shopTypeCol} AS shop_type` : ""},

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
      ${supplierAgg.selectSql}

    FROM products p
    LEFT JOIN shops s ON s.id = p.shop_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
    ${supplierAgg.joinSql}
  `;
}

function mapProductRow(r) {
  addSupplierAggToRow(r);

  const base = stripDuuminiRateFromProduct(r);

  const variants_count = Number(r.variants_count || 0);
  const min_price =
    r.min_price == null || r.min_price === "" ? null : Number(r.min_price ?? 0);

  const merged = {
    ...base,
    has_variants: variants_count > 0,
    min_price: Number.isFinite(min_price) ? min_price : null,
    variants_count,

    shop_type: r.shop_type ? normalizeShopType(r.shop_type) : null,

    supplier_stock: r.supplier_stock == null ? null : Number(r.supplier_stock),
    supplier_cost: r.supplier_cost == null ? null : Number(r.supplier_cost),
    supplier_last_supply_at: r.supplier_last_supply_at ?? null,
  };

  return withPromoComputed(merged);
}

async function listProducts(pool, opts) {
  const {
    limit,
    offset,
    channel,
    activeFilter,
    onlyPromos,
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
    ownerId,
    onlyDrinks,
    excludeDrinks,
    catalogueMode,
  } = opts || {};

  const whereParts = [];
  const params = [];

  const v = normalizeVertical(vertical, null);
  if (v) {
    whereParts.push("p.vertical = ?");
    params.push(v);
  } else {
    if (channel === "african-food") whereParts.push("p.vertical = 'FOOD'");
    else if (channel === "african-market") whereParts.push("p.vertical = 'MARKET'");
    else whereParts.push("1=1");
  }

  if (activeFilter === 1) whereParts.push("p.is_active = 1");
  if (activeFilter === 0) whereParts.push("p.is_active = 0");

  if (onlyPromos) {
    whereParts.push(`(p.promo_eligible = 1 AND COALESCE(p.promo_discount_value, 0) > 0)`);
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

  const oid = Number(ownerId) || 0;
  if (oid) {
    whereParts.push("s.owner_id = ?");
    params.push(oid);
  }

  const qq = String(q || "").trim().toLowerCase();
  if (qq) {
    whereParts.push(`
      (
        LOWER(p.name) LIKE ?
        OR LOWER(COALESCE(p.description,'')) LIKE ?
        OR LOWER(COALESCE(s.name,'')) LIKE ?
      )
    `);
    const like = `%${qq}%`;
    params.push(like, like, like);
  }

  if (parseBoolFlag(onlyWithVariants, 0) === 1) {
    whereParts.push(
      `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1)`
    );
  }

  const drinkCatId = await getDrinkCategoryIdCached(pool);

  if (parseBoolFlag(onlyDrinks, 0) === 1) {
    whereParts.push("p.vertical = 'FOOD'");
    whereParts.push("p.category_id = ?");
    params.push(drinkCatId);
  }

  if (parseBoolFlag(excludeDrinks, 0) === 1) {
    whereParts.push(`NOT (p.vertical = 'FOOD' AND p.category_id = ?)`);
    params.push(drinkCatId);
  }

  const shopTypeCol = await getShopTypeColCached(pool);
  if (shopTypeCol) {
    if (catalogueMode === "PUBLIC_CLIENT") {
      whereParts.push(
        `(UPPER(COALESCE(s.${shopTypeCol}, 'VENDOR')) IN ('VENDOR','VENDEUR','SHOP','RESTAURANT'))`
      );
    } else if (catalogueMode === "SUPPLIER_ONLY") {
      whereParts.push(
        `(UPPER(COALESCE(s.${shopTypeCol}, '')) IN ('SUPPLIER','FOURNISSEUR'))`
      );
    }
  }

  const whereSql = whereParts.length ? whereParts.join(" AND ") : "1=1";

  const { shopTypeCol: stCol, supplierAgg } = await getSelectMeta(pool);
  const selectSql = baseSelectSql(stCol, supplierAgg);

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
    ${selectSql}
    WHERE ${whereSql}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
    `,
    [...params, Number(limit), Number(offset)]
  );

  let rows = (rowsRaw || []).map(mapProductRow);

  rows = await attachVariantsToProducts(pool, rows, {
    includeVariants: !!includeVariants,
  });

  return { rows, total };
}

function applyPageSizeAlias(req) {
  if (req?.query && req.query.pageSize == null && req.query.pagesize != null) {
    req.query.pageSize = req.query.pagesize;
  }
}

async function listHandler(req, res, next) {
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 500,
  });

  const activeFilter = parseActiveFilter(req, 1);

  const {
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
    onlyDrinks,
    excludeDrinks,
    onlyPromos,
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
      activeFilter,
      onlyPromos: parseBoolFlag(onlyPromos, 0) === 1,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical,
      includeVariants: include,
      onlyWithVariants,
      ownerId: null,
      onlyDrinks,
      excludeDrinks,
      catalogueMode: "PUBLIC_CLIENT",
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
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 500,
  });

  const activeFilter = parseActiveFilter(req, 1);
  const { categoryId, subCategoryId, shopId, q, onlyPromos } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-food",
      activeFilter,
      onlyPromos: parseBoolFlag(onlyPromos, 0) === 1,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical: null,
      includeVariants: false,
      onlyWithVariants: 0,
      ownerId: null,
      catalogueMode: "PUBLIC_CLIENT",
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
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 500,
  });

  const activeFilter = parseActiveFilter(req, 1);
  const { categoryId, subCategoryId, shopId, q, onlyPromos } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: "african-market",
      activeFilter,
      onlyPromos: parseBoolFlag(onlyPromos, 0) === 1,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical: null,
      includeVariants: false,
      onlyWithVariants: 0,
      ownerId: null,
      catalogueMode: "PUBLIC_CLIENT",
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function listShopDrinksHandler(req, res, next) {
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 500,
  });

  const pool = getPool();

  try {
    const drinkCatId = await getDrinkCategoryIdCached(pool);

    const shopId = Number(req.query.shopId ?? req.query.shop_id ?? 0);
    if (!shopId) return res.status(400).json({ error: "shopId requis" });

    const activeFilter = parseActiveFilter(req, 1);
    const q = String(req.query.q ?? "").trim();
    const onlyPromos = parseBoolQuery(req, "onlyPromos", 0);

    const citiesCol = await getCitiesColCached(pool);

    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      activeFilter,
      onlyPromos: onlyPromos === 1,
      categoryId: drinkCatId,
      subCategoryId: null,
      shopId,
      q,
      vertical: "FOOD",
      includeVariants: false,
      onlyWithVariants: 0,
      ownerId: null,
      catalogueMode: "PUBLIC_CLIENT",
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function listSuppliersCatalogueHandler(req, res, next) {
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 500,
  });

  const activeFilter = parseActiveFilter(req, 1);

  const {
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
    onlyDrinks,
    excludeDrinks,
    onlyPromos,
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
      activeFilter,
      onlyPromos: parseBoolFlag(onlyPromos, 0) === 1,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical,
      includeVariants: include,
      onlyWithVariants,
      ownerId: null,
      onlyDrinks,
      excludeDrinks,
      catalogueMode: "SUPPLIER_ONLY",
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function listManageHandler(req, res, next) {
  applyPageSizeAlias(req);

  const { page, pageSize, offset, limit } = getPagination(req, {
    page: 1,
    pageSize: 50,
    maxPageSize: 1000,
  });

  const activeFilter = parseActiveFilter(req, null);

  const {
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
    onlyWithVariants,
    onlyDrinks,
    excludeDrinks,
    onlyPromos,
  } = pickFilters(req);

  const pool = getPool();
  try {
    const citiesCol = await getCitiesColCached(pool);

    const v = normalizeVertical(vertical, null);
    const include = includeVariants === 1 ? true : v === "FASHION" ? true : false;

    const actorId = actingUserId(req);
    const ownerId = isActingVendorOrRestaurant(req) ? actorId : null;
    const safeShopId = isActingVendorOrRestaurant(req) ? null : shopId;

    const { rows, total } = await listProducts(pool, {
      limit,
      offset,
      channel: null,
      activeFilter,
      onlyPromos: parseBoolFlag(onlyPromos, 0) === 1,
      categoryId,
      subCategoryId,
      shopId: safeShopId,
      q,
      vertical,
      includeVariants: include,
      onlyWithVariants,
      ownerId,
      onlyDrinks,
      excludeDrinks,
      catalogueMode: null,
    });

    res.json({
      items: withCities(rows, citiesCol),
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    next(e);
  }
}

async function getProductFullBy(conn, pool, whereSql, whereParams, opts = {}) {
  const wantVariants = !!opts.wantVariants;
  const wantImages = opts.wantImages !== false;

  const citiesCol = await getCitiesColCached(pool);
  const { shopTypeCol, supplierAgg } = await getSelectMeta(pool);
  const selectSql = baseSelectSql(shopTypeCol, supplierAgg);

  const [rows] = await conn.query(
    `
    ${selectSql}
    ${whereSql}
    LIMIT 1
    `,
    whereParams
  );

  const raw = rows?.[0] || null;
  if (!raw) return null;

  const product = mapProductRow(raw);

  let images = [];
  if (wantImages) {
    const [imgs] = await conn.query(
      `SELECT id, url, sort_order
         FROM product_images
        WHERE product_id=?
        ORDER BY sort_order ASC, id ASC`,
      [raw.id]
    );
    images = imgs || [];
  }

  let variants = undefined;
  if (wantVariants) {
    const [vrows] = await conn.query(
      `SELECT id, product_id, size, color, sku, stock, price_override, is_active
         FROM product_variants
        WHERE product_id=?
        ORDER BY is_active DESC, id ASC`,
      [raw.id]
    );
    variants = vrows || [];
  }

  let cities = null;
  if (citiesCol) cities = normalizeCitiesValue(raw?.[citiesCol]);

  return {
    ...product,
    images,
    ...(variants ? { variants } : {}),
    ...(cities ? { cities } : {}),
  };
}

async function getManageByIdHandler(req, res, next) {
  const id = parseIdParam(req.params.id);
  if (!id) return next();

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [[ownerRow]] = await conn.query(
      `SELECT s.owner_id
         FROM products p
         LEFT JOIN shops s ON s.id = p.shop_id
        WHERE p.id=? LIMIT 1`,
      [id]
    );
    if (!ownerRow) return res.status(404).json({ error: "Not found" });

    const actorId = actingUserId(req);
    if (isActingVendorOrRestaurant(req) && String(ownerRow.owner_id) !== String(actorId)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const wantVariants = parseVariantsQuery(req);

    const full = await getProductFullBy(conn, pool, `WHERE p.id=?`, [id], {
      wantVariants,
      wantImages: true,
    });

    if (!full) return res.status(404).json({ error: "Not found" });

    res.json(full);
  } catch (e) {
    next(e);
  } finally {
    conn.release();
  }
}

async function getManageBySlugHandler(req, res, next) {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) return next();

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query(
      `SELECT s.owner_id
         FROM products p
         LEFT JOIN shops s ON s.id = p.shop_id
        WHERE LOWER(TRIM(p.slug))=? LIMIT 1`,
      [slug]
    );
    if (!row) return res.status(404).json({ error: "Not found" });

    const actorId = actingUserId(req);
    if (isActingVendorOrRestaurant(req) && String(row.owner_id) !== String(actorId)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const wantVariants = parseVariantsQuery(req);

    const full = await getProductFullBy(
      conn,
      pool,
      `WHERE LOWER(TRIM(p.slug))=?`,
      [slug],
      {
        wantVariants,
        wantImages: true,
      }
    );

    if (!full) return res.status(404).json({ error: "Not found" });

    res.json(full);
  } catch (e) {
    next(e);
  } finally {
    conn.release();
  }
}

async function getPublicBySlugHandler(req, res, next) {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) return next();

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const wantVariants = parseVariantsQuery(req);

    const full = await getProductFullBy(
      conn,
      pool,
      `WHERE LOWER(TRIM(p.slug))=? AND p.is_active=1`,
      [slug],
      {
        wantVariants,
        wantImages: true,
      }
    );

    if (!full) return res.status(404).json({ error: "Not found" });

    res.json(full);
  } catch (e) {
    next(e);
  } finally {
    conn.release();
  }
}

async function getPublicByIdHandler(req, res, next) {
  const id = parseIdParam(req.params.id);
  if (!id) return next();

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const wantVariants = parseVariantsQuery(req);

    const full = await getProductFullBy(
      conn,
      pool,
      `WHERE p.id=? AND p.is_active=1`,
      [id],
      {
        wantVariants,
        wantImages: true,
      }
    );

    if (!full) return res.status(404).json({ error: "Not found" });

    res.json(full);
  } catch (e) {
    next(e);
  } finally {
    conn.release();
  }
}

async function promotionsHandler(req, res, next) {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 12);

  const channel = String(req.query.channel || "all").toLowerCase();
  const channelNorm =
    channel === "african-food"
      ? "african-food"
      : channel === "african-market"
      ? "african-market"
      : null;

  const activeFilter = parseActiveFilter(req, 1);
  const {
    categoryId,
    subCategoryId,
    shopId,
    q,
    vertical,
    includeVariants,
  } = pickFilters(req);

  try {
    const citiesCol = await getCitiesColCached(pool);

    const { rows } = await listProducts(pool, {
      limit,
      offset: 0,
      channel: channelNorm,
      activeFilter,
      onlyPromos: true,
      categoryId,
      subCategoryId,
      shopId,
      q,
      vertical,
      includeVariants:
        includeVariants === 1
          ? true
          : normalizeVertical(vertical, null) === "FASHION",
      onlyWithVariants: 0,
      ownerId: null,
      catalogueMode: "PUBLIC_CLIENT",
    });

    res.json(withCities(rows, citiesCol).slice(0, limit));
  } catch (e) {
    next(e);
  }
}

async function topOrderedHandler(req, res, next) {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);

  try {
    const citiesCol = await getCitiesColCached(pool);
    const shopTypeCol = await getShopTypeColCached(pool);

    const [rowsRaw] = await pool.query(
      `
      SELECT
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city
        ${shopTypeCol ? `, s.${shopTypeCol} AS shop_type` : ""},

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

    const mapped = (rowsRaw || []).map((r) => {
      const base = withPromoComputed(stripDuuminiRateFromProduct(r));
      return {
        ...base,
        shop_type: r.shop_type ? normalizeShopType(r.shop_type) : null,
      };
    });

    res.json(withCities(mapped, citiesCol));
  } catch (e) {
    next(e);
  }
}

async function topRatedHandler(req, res, next) {
  const pool = getPool();
  const limit = toPositiveInt(req.query.limit, 8);
  const minCount = toPositiveInt(req.query.minCount, 2);

  try {
    const citiesCol = await getCitiesColCached(pool);
    const shopTypeCol = await getShopTypeColCached(pool);

    const [rowsRaw] = await pool.query(
      `
      SELECT
        p.*,
        s.name AS shop_name,
        s.logo AS shop_logo,
        s.cover AS shop_cover,
        s.city AS shop_city
        ${shopTypeCol ? `, s.${shopTypeCol} AS shop_type` : ""},

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

    const mapped = (rowsRaw || []).map((r) => {
      const base = withPromoComputed(stripDuuminiRateFromProduct(r));
      return {
        ...base,
        shop_type: r.shop_type ? normalizeShopType(r.shop_type) : null,
      };
    });

    res.json(withCities(mapped, citiesCol));
  } catch (e) {
    next(e);
  }
}

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

router.put(
  "/variants/:variantId",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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

      const actorId = actingUserId(req);
      if (isActingVendorOrRestaurant(req) && String(v.owner_id) !== String(actorId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const size = req.body?.size === undefined ? null : normalizeSize(req.body.size);
      const color = req.body?.color === undefined ? null : normalizeColor(req.body.color);
      const sku = req.body?.sku === undefined ? null : normalizeSku(req.body.sku);

      const stock =
        req.body?.stock === undefined
          ? null
          : Number.isFinite(Number(req.body.stock)) && Number(req.body.stock) >= 0
          ? Math.floor(Number(req.body.stock))
          : 0;

      const hasPriceOverride = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "price_override"
      );

      let price_override = null;
      if (hasPriceOverride) {
        if (req.body.price_override == null || req.body.price_override === "") {
          price_override = null;
        } else {
          const po = Number(req.body.price_override);
          price_override = Number.isFinite(po) && po >= 0 ? po : null;
        }
      }

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
           price_override = CASE WHEN ? = 0 THEN price_override ELSE ? END,
           is_active = COALESCE(?, is_active)
         WHERE id=?`,
        [
          size,
          color,
          sku,
          stock,
          hasPriceOverride ? 1 : 0,
          hasPriceOverride ? price_override : null,
          active,
          variantId,
        ]
      );

      clearProductsCache();
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

router.delete(
  "/variants/:variantId",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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

      const actorId = actingUserId(req);
      if (isActingVendorOrRestaurant(req) && String(v.owner_id) !== String(actorId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await conn.query(`DELETE FROM product_variants WHERE id=?`, [variantId]);

      clearProductsCache();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

router.post(
  "/:id/variants",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  express.json(),
  async (req, res, next) => {
    const productId = parseIdParam(req.params.id);
    if (!productId) return next();

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const auth = await assertCanMutateProduct(conn, req.user, productId);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

      const replace = parseBoolFlag(req.query.replace ?? req.body?.replace, 0) === 1;

      const variants = parseVariantsBody(req.body);
      if (!variants.length) {
        return res.status(400).json({ error: "variants requis (array JSON)" });
      }

      await conn.beginTransaction();

      if (replace) {
        await conn.query(`DELETE FROM product_variants WHERE product_id=?`, [productId]);
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
          [productId, v.size, v.color, v.sku, v.stock, v.price_override, v.is_active ?? 1]
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

      clearProductsCache();
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

router.get(
  "/slug/:slug",
  cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS),
  getPublicBySlugHandler
);
router.get("/:id", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), getPublicByIdHandler);

router.post(
  "/",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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
      let finalCountryCode = "MA";
      const actorId = actingUserId(req);
      const forcedShopId = actingShopId(req);

      if (isActingVendorOrRestaurant(req)) {
        if (forcedShopId) {
          const [[shop]] = await conn.query(
            `SELECT id, owner_id, country_code FROM shops WHERE id=? LIMIT 1`,
            [forcedShopId]
          );
          if (!shop) {
            return res
              .status(400)
              .json({ error: "Boutique invalide (impersonate_shop_id)" });
          }
          if (String(shop.owner_id) !== String(actorId)) {
            return res.status(403).json({ error: "Forbidden" });
          }
          finalShopId = Number(shop.id);
          finalCountryCode = shop.country_code || "MA";
        } else if (shop_id != null && shop_id !== "") {
          // ✅ Le vendeur/restaurant a explicitement choisi une boutique
          // (multi-boutiques) — on vérifie qu'elle lui appartient bien.
          const sid = Number(shop_id) || 0;
          if (!sid) {
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          const [[shop]] = await conn.query(
            `SELECT id, owner_id, country_code FROM shops WHERE id=? LIMIT 1`,
            [sid]
          );
          if (!shop) {
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          if (String(shop.owner_id) !== String(actorId)) {
            return res
              .status(403)
              .json({ error: "Forbidden: cette boutique ne vous appartient pas" });
          }
          finalShopId = Number(shop.id);
          finalCountryCode = shop.country_code || "MA";
        } else {
          const [[shop]] = await conn.query(
            `SELECT id, country_code FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
            [actorId]
          );
          if (!shop) {
            return res
              .status(400)
              .json({ error: "Aucune boutique associée à ce compte" });
          }
          finalShopId = Number(shop.id);
          finalCountryCode = shop.country_code || "MA";
        }
      } else if (isAdmin(req.user)) {
        const sid = Number(shop_id) || 0;
        if (!sid) {
          return res
            .status(400)
            .json({ error: "shop_id requis pour la création par un admin" });
        }
        const [[shop]] = await conn.query(
          `SELECT id, country_code FROM shops WHERE id=? LIMIT 1`,
          [sid]
        );
        if (!shop) {
          return res.status(400).json({ error: "Boutique invalide (shop_id)" });
        }
        finalShopId = sid;
        finalCountryCode = shop.country_code || "MA";
      } else {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (!name || price == null) {
        return res.status(400).json({ error: "name et price requis" });
      }

      const drinkCatId = await getDrinkCategoryIdCached(pool);
      const catIdNum = category_id ? Number(category_id) : null;
      const isDrink = isDrinkCategoryId(catIdNum, drinkCatId);

      let resolvedSub = null;
      if (!isDrink) {
        resolvedSub = await resolveSubCategory(conn, {
          sub_category_id,
          category_id,
        });
        if (!resolvedSub) {
          return res.status(400).json({
            error: "sub_category_id invalide (ou ne correspond pas à category_id)",
          });
        }
      }

      const incomingVertical = normalizeVertical(vertical, null);

      let finalVertical = null;
      if (isDrink) finalVertical = "FOOD";
      else if (incomingVertical) finalVertical = incomingVertical;
      else {
        const subV = normalizeVertical(resolvedSub?.vertical, null);
        finalVertical = subV || "MARKET";
      }

      const duuminiRate = finalVertical === "FOOD" ? 0.18 : 0.11;
      const active = parseBoolFlag(is_active, 1);

      const makeSlug = () =>
        (slug && String(slug).trim()) ||
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toLowerCase();

      const promo = parsePromoFields({
        promo_eligible,
        promo_discount_type,
        promo_discount_value,
        promo_free_delivery,
      });

      const incomingCities = parseCitiesBody(req.body);
      const cities = incomingCities == null ? null : incomingCities;
      const citiesJson = citiesCol && cities != null ? JSON.stringify(cities) : null;

      const variantsList = parseVariantsBody({ variants });
      const replace = parseBoolFlag(replace_variants, 0) === 1;

      await conn.beginTransaction();

      let insertSql = `INSERT INTO products
        (shop_id, country_code, category_id, sub_category_id, name, slug, price, currency, description, stock, is_featured,
         promo_eligible, promo_discount_type, promo_discount_value, promo_free_delivery,
         duumini_rate, is_active, vertical`;

      const promoEligibleFinal = promo.promo_mode === "UNTOUCHED" ? 0 : promo.promo_eligible ?? 0;

      const insertVals = [
        finalShopId,
        finalCountryCode,
        category_id ? Number(category_id) : null,
        isDrink ? null : resolvedSub.id,
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
          await conn.query(`DELETE FROM product_variants WHERE product_id=?`, [productId]);
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
            [productId, v.size, v.color, v.sku, v.stock, v.price_override, v.is_active ?? 1]
          );
        }
      }

      await conn.commit();

      const channel = finalVertical === "FOOD" ? "african-food" : "african-market";

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
      } catch {}

      try {
        const { getIO, emitToShops } = require("../ws");
        const io = getIO && getIO();
        if (io && emitToShops && finalShopId != null) {
          emitToShops([finalShopId], "product:created", { product_id: productId });
        }
      } catch {}

      clearProductsCache();
      res.status(201).json({ id: productId, channel, vertical: finalVertical });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate slug" });
      }
      if (e && e.code === "ER_NO_REFERENCED_ROW_2") {
        return res.status(400).json({ error: "FK invalid (category/sub_category?)" });
      }
      next(e);
    } finally {
      conn.release();
    }
  }
);

router.put(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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
      const drinkCatId = await getDrinkCategoryIdCached(pool);

      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id
           FROM products p
           LEFT JOIN shops s ON s.id = p.shop_id
          WHERE p.id=?`,
        [id]
      );
      if (!prod) return res.status(404).json({ error: "Not found" });

      const actorId = actingUserId(req);
      if (isActingVendorOrRestaurant(req) && String(prod.owner_id) !== String(actorId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let newShopIdParam = null;
      let newCountryCodeParam = null;
      if (shop_id != null && shop_id !== "") {
        const sid = Number(shop_id) || 0;
        if (sid > 0 && isAdmin(req.user)) {
          const [[shop]] = await conn.query(
            `SELECT id, country_code FROM shops WHERE id=? LIMIT 1`,
            [sid]
          );
          if (!shop) {
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          newShopIdParam = sid;
          newCountryCodeParam = shop.country_code || "MA";
        } else if (sid > 0 && isActingVendorOrRestaurant(req)) {
          // ✅ Le vendeur/restaurant peut changer la boutique d'un produit
          // (multi-boutiques), à condition qu'elle lui appartienne.
          const [[shop]] = await conn.query(
            `SELECT id, owner_id, country_code FROM shops WHERE id=? LIMIT 1`,
            [sid]
          );
          if (!shop) {
            return res.status(400).json({ error: "Boutique invalide (shop_id)" });
          }
          if (String(shop.owner_id) !== String(actorId)) {
            return res
              .status(403)
              .json({ error: "Forbidden: cette boutique ne vous appartient pas" });
          }
          newShopIdParam = sid;
          newCountryCodeParam = shop.country_code || "MA";
        }
      }

      const incomingCategoryId =
        category_id != null && category_id !== ""
          ? Number(category_id)
          : Number(prod.category_id || 0);

      const targetIsDrink = isDrinkCategoryId(incomingCategoryId, drinkCatId);

      let resolvedSub = null;
      if (!targetIsDrink) {
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
      }

      const active = parseBoolFlag(is_active, null);
      const promo = parsePromoFields({
        promo_eligible,
        promo_discount_type,
        promo_discount_value,
        promo_free_delivery,
      });

      const vertIncoming = normalizeVertical(vertical, null);
      const subV = normalizeVertical(resolvedSub?.vertical, null);
      const vertFinal = targetIsDrink ? "FOOD" : vertIncoming || subV || null;

      const duuminiRateParam = targetIsDrink
        ? 0.18
        : resolvedSub
        ? normalizeVertical(resolvedSub.vertical, "MARKET") === "FOOD"
          ? 0.18
          : 0.11
        : vertIncoming
        ? vertIncoming === "FOOD"
          ? 0.18
          : 0.11
        : null;

      const subCategoryParam = targetIsDrink ? null : resolvedSub ? resolvedSub.id : null;
      const subUpdateMode = targetIsDrink ? "SET_NULL" : resolvedSub ? "SET_ID" : "KEEP";

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

           sub_category_id     = CASE
                                   WHEN ? = 'SET_NULL' THEN NULL
                                   WHEN ? = 'SET_ID'   THEN ?
                                   ELSE sub_category_id
                                 END,
           duumini_rate        = COALESCE(?, duumini_rate),

           is_active           = COALESCE(?, is_active),
           category_id         = COALESCE(?, category_id),
           shop_id             = COALESCE(?, shop_id),
           country_code        = COALESCE(?, country_code),
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

          subUpdateMode,
          subUpdateMode,
          subCategoryParam,

          duuminiRateParam,

          active,
          category_id != null && category_id !== "" ? Number(category_id) : null,
          newShopIdParam,
          newCountryCodeParam,
          vertFinal,

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

      clearProductsCache();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

router.put(
  "/:id/images",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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

      const actorId = actingUserId(req);
      if (isActingVendorOrRestaurant(req) && String(prod.owner_id) !== String(actorId)) {
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

      clearProductsCache();
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

router.delete(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
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

      const actorId = actingUserId(req);
      if (isActingVendorOrRestaurant(req) && String(prod.owner_id) !== String(actorId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const [imgs] = await conn.query(
        `SELECT url FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`,
        [id]
      );

      await conn.beginTransaction();

      try {
        const meta = await getSupplierMetaCached(pool);
        if (meta?.enabled) {
          await conn.query(`DELETE FROM supplier_products WHERE product_id=?`, [id]);
        }
      } catch {}

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

      clearProductsCache();
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

router.get("/fashion", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), async (req, res, next) => {
  req.query.vertical = "FASHION";
  if (req.query.includeVariants == null) req.query.includeVariants = "1";
  return listHandler(req, res, next);
});

router.get("/drinks", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), listShopDrinksHandler);

router.get(
  "/suppliers",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  cachedJson("AUTH", PRODUCTS_CACHE_TTL_MS),
  listSuppliersCatalogueHandler
);

router.get(
  "/manage",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  cachedJson("AUTH", PRODUCTS_CACHE_TTL_MS),
  listManageHandler
);

router.get(
  "/manage/slug/:slug",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  cachedJson("AUTH", PRODUCTS_CACHE_TTL_MS),
  getManageBySlugHandler
);

router.get(
  "/manage/:id",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  cachedJson("AUTH", PRODUCTS_CACHE_TTL_MS),
  getManageByIdHandler
);

router.get("/", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), listHandler);
router.get("/african-food", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), listFoodHandler);
router.get("/african-market", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), listMarketHandler);

router.get("/promotions", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), promotionsHandler);
router.get("/top-ordered", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), topOrderedHandler);
router.get("/top-rated", cachedJson("PUBLIC", PRODUCTS_CACHE_TTL_MS), topRatedHandler);
router.patch(
  "/:id/stock-status",
  authRequired,
  requireRole("VENDEUR", "RESTAURANT", "ADMIN"),
  express.json(),
  async (req, res, next) => {
    const id = parseIdParam(req.params.id);
    if (!id) return next();

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      const auth = await assertCanMutateProduct(conn, req.user, id);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }

      const isOut =
        String(req.body?.is_out_of_stock ?? "").trim() === "true" ||
        String(req.body?.is_out_of_stock ?? "").trim() === "1" ||
        req.body?.is_out_of_stock === true;

      const messageRaw = String(req.body?.availability_message || "").trim();

      const stockStatus = isOut ? "OUT_OF_STOCK" : "IN_STOCK";
      const availabilityMessage = isOut
        ? messageRaw || "Ce produit est actuellement en rupture de stock."
        : (messageRaw || null);

      await conn.query(
        `
        UPDATE products
        SET stock_status = ?,
            availability_message = ?
        WHERE id = ?
        `,
        [stockStatus, availabilityMessage, id]
      );

      clearProductsCache();

      res.json({
        ok: true,
        id,
        stock_status: stockStatus,
        is_out_of_stock: isOut,
        availability_message: availabilityMessage,
      });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);
module.exports = router;