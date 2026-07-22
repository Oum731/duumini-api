const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { normPhone } = require("../utils/phone");
const { env } = require("../lib/env");

const router = Router();

const COMMISSION_STATUSES = ["PENDING", "APPROVED", "PAID", "CANCELLED"];
const PERIOD_TYPES = ["DAY", "WEEK", "MONTH", "YEAR"];

function normalizeAffiliateCode(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return v || null;
}

function normalizeSlug(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return v || null;
}

function normalizeProductId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normRate(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return +n.toFixed(2);
}

function normStatus(value, fallback = "ACTIVE") {
  const v = String(value || fallback).trim().toUpperCase();
  return v === "INACTIVE" ? "INACTIVE" : "ACTIVE";
}

function normCommissionStatus(value, fallback = "PENDING") {
  const v = String(value || fallback).trim().toUpperCase();
  return COMMISSION_STATUSES.includes(v) ? v : fallback;
}

function normPeriodType(value, fallback = "MONTH") {
  const v = String(value || fallback).trim().toUpperCase();
  return PERIOD_TYPES.includes(v) ? v : fallback;
}

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    null
  );
}

function publicWebBase() {
  return String(
    env.PUBLIC_WEB_BASE ||
      process.env.PUBLIC_WEB_BASE ||
      "https://duumini.com",
  ).replace(/\/+$/, "");
}

function publicApiBase() {
  return String(
    env.PUBLIC_API_BASE ||
      process.env.PUBLIC_API_BASE ||
      "https://duumini-api.onrender.com",
  ).replace(/\/+$/, "");
}

function buildSafeLandingUrl(landing) {
  const webBase = publicWebBase();
  const cleanLanding = String(landing || "/").trim() || "/";

  if (/^https?:\/\//i.test(cleanLanding)) {
    try {
      const url = new URL(cleanLanding);
      const allowed = new URL(webBase);

      if (url.hostname === allowed.hostname) {
        return cleanLanding;
      }

      return webBase;
    } catch {
      return webBase;
    }
  }

  return `${webBase}${cleanLanding.startsWith("/") ? cleanLanding : `/${cleanLanding}`}`;
}

function buildTrackUrlByCode(code, to = "/") {
  const cleanCode = normalizeAffiliateCode(code);
  if (!cleanCode) return null;

  return `${publicApiBase()}/api/affiliates/track/${encodeURIComponent(
    cleanCode,
  )}?to=${encodeURIComponent(to || "/")}`;
}

function buildTrackUrlBySlug(slug, to = "/") {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return null;

  return `${publicApiBase()}/api/affiliates/ref/${encodeURIComponent(
    cleanSlug,
  )}?to=${encodeURIComponent(to || "/")}`;
}

function detectDevice(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return null;
  if (/mobile|android|iphone|ipod|windows phone/i.test(ua)) return "mobile";
  if (/ipad|tablet/i.test(ua)) return "tablet";
  return "desktop";
}

function normalizeSource(value) {
  const v = String(value || "").trim().toLowerCase();
  return v || null;
}

function extractSource(req, landingUrl = "") {
  const q = normalizeSource(req.query?.source);
  if (q) return q;

  const ref = normalizeSource(req.headers.referer || req.headers.referrer || "");
  if (!ref) return null;

  if (ref.includes("facebook")) return "facebook";
  if (ref.includes("instagram")) return "instagram";
  if (ref.includes("tiktok")) return "tiktok";
  if (ref.includes("whatsapp")) return "whatsapp";

  const landing = normalizeSource(landingUrl);
  if (landing?.includes("utm_source=")) {
    const m = landing.match(/[?&]utm_source=([^&]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]).toLowerCase();
  }

  return "direct";
}

function extractProductIdFromLanding(landing) {
  const text = String(landing || "").trim();
  if (!text) return null;

  const urlPart = text.split("?")[0] || text;

  const match =
    urlPart.match(/\/product\/(\d+)(?:\/|$)/i) ||
    urlPart.match(/\/products\/(\d+)(?:\/|$)/i) ||
    urlPart.match(/\/p\/(\d+)(?:\/|$)/i);

  if (match?.[1]) return normalizeProductId(match[1]);

  const queryMatch =
    text.match(/[?&]product_id=(\d+)/i) ||
    text.match(/[?&]productId=(\d+)/i) ||
    text.match(/[?&]pid=(\d+)/i);

  if (queryMatch?.[1]) return normalizeProductId(queryMatch[1]);
  return null;
}

function toDateOnly(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function startOfDay(value) {
  const d = value ? new Date(value) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(value) {
  const d = value ? new Date(value) : new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfWeek(value) {
  const d = startOfDay(value);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function endOfWeek(value) {
  const d = startOfWeek(value);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(value) {
  const d = value ? new Date(value) : new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(value) {
  const d = startOfMonth(value);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfYear(value) {
  const d = value ? new Date(value) : new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfYear(value) {
  const d = startOfYear(value);
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function periodMeta(periodType, baseDate = new Date()) {
  const type = normPeriodType(periodType, "MONTH");
  let start;
  let end;
  let key;

  if (type === "DAY") {
    start = startOfDay(baseDate);
    end = endOfDay(baseDate);
    key = start.toISOString().slice(0, 10);
  } else if (type === "WEEK") {
    start = startOfWeek(baseDate);
    end = endOfWeek(baseDate);
    key = start.toISOString().slice(0, 10);
  } else if (type === "YEAR") {
    start = startOfYear(baseDate);
    end = endOfYear(baseDate);
    key = String(start.getFullYear());
  } else {
    start = startOfMonth(baseDate);
    end = endOfMonth(baseDate);
    key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  }

  return {
    period_type: type,
    period_key: key,
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

function parseAffiliate(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    affiliate_code: row.affiliate_code || null,
    referral_slug: row.referral_slug || null,
    name: row.name || null,
    phone: row.phone || null,
    commission_rate: Number(row.commission_rate || 0),
    status: row.status || "INACTIVE",
    total_clicks: Number(row.total_clicks || 0),
    total_orders: Number(row.total_orders || 0),
    total_earnings: Number(row.total_earnings || 0),
    notes: row.notes || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    share_url_by_code: row.affiliate_code
      ? `${publicWebBase()}/?ref=${encodeURIComponent(row.affiliate_code)}`
      : null,
    share_url_by_slug: row.referral_slug
      ? `${publicWebBase()}/ref/${encodeURIComponent(row.referral_slug)}`
      : null,
    track_url_by_code: row.affiliate_code
      ? buildTrackUrlByCode(row.affiliate_code, "/")
      : null,
    track_url_by_slug: row.referral_slug
      ? buildTrackUrlBySlug(row.referral_slug, "/")
      : null,
  };
}

async function detectUsersBasicCols(conn) {
  const candidates = ["id", "first_name", "last_name", "phone", "role"];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    first_name: found.has("first_name"),
    last_name: found.has("last_name"),
    phone: found.has("phone"),
    role: found.has("role"),
  };
}

async function buildAffiliateUserSelect(conn) {
  const cols = await detectUsersBasicCols(conn);

  return [
    "u.id AS user_id",
    cols.first_name ? "u.first_name AS u_first_name" : "NULL AS u_first_name",
    cols.last_name ? "u.last_name AS u_last_name" : "NULL AS u_last_name",
    cols.phone ? "u.phone AS u_phone" : "NULL AS u_phone",
    cols.role ? "u.role AS u_role" : "NULL AS u_role",
  ];
}

async function detectAffiliateClickCols(conn) {
  const candidates = [
    "affiliate_id",
    "affiliate_code",
    "ip_address",
    "user_agent",
    "referer_url",
    "landing_url",
    "created_at",
    "product_id",
    "source",
    "device",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'affiliate_clicks'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    affiliate_code: found.has("affiliate_code"),
    ip_address: found.has("ip_address"),
    user_agent: found.has("user_agent"),
    referer_url: found.has("referer_url"),
    landing_url: found.has("landing_url"),
    created_at: found.has("created_at"),
    product_id: found.has("product_id"),
    source: found.has("source"),
    device: found.has("device"),
  };
}

async function affiliateExistsByCode(conn, affiliate_code, excludeId = null) {
  const code = normalizeAffiliateCode(affiliate_code);
  if (!code) return false;

  if (excludeId) {
    const [[row]] = await conn.query(
      `
        SELECT id
        FROM affiliates
        WHERE affiliate_code = ?
          AND id <> ?
        LIMIT 1
      `,
      [code, excludeId],
    );
    return !!row;
  }

  const [[row]] = await conn.query(
    `
      SELECT id
      FROM affiliates
      WHERE affiliate_code = ?
      LIMIT 1
    `,
    [code],
  );
  return !!row;
}

async function affiliateExistsBySlug(conn, referral_slug, excludeId = null) {
  const slug = normalizeSlug(referral_slug);
  if (!slug) return false;

  if (excludeId) {
    const [[row]] = await conn.query(
      `
        SELECT id
        FROM affiliates
        WHERE referral_slug = ?
          AND id <> ?
        LIMIT 1
      `,
      [slug, excludeId],
    );
    return !!row;
  }

  const [[row]] = await conn.query(
    `
      SELECT id
      FROM affiliates
      WHERE referral_slug = ?
      LIMIT 1
    `,
    [slug],
  );
  return !!row;
}

async function generateUniqueAffiliateCode(conn, base = "DUU") {
  for (let i = 0; i < 20; i++) {
    const code = `${base}${Math.floor(100000 + Math.random() * 900000)}`;
    const exists = await affiliateExistsByCode(conn, code);
    if (!exists) return code;
  }

  return `DUU${Date.now()}`;
}

async function generateUniqueSlug(conn, rawBase, excludeId = null) {
  const base = normalizeSlug(rawBase || "affilie") || "affilie";
  let slug = base;
  let i = 1;

  while (await affiliateExistsBySlug(conn, slug, excludeId)) {
    i += 1;
    slug = `${base}-${i}`;
  }

  return slug;
}

async function findAffiliateById(conn, id) {
  const userSelectCols = await buildAffiliateUserSelect(conn);

  const [[row]] = await conn.query(
    `
      SELECT
        a.*,
        ${userSelectCols.join(", ")}
      FROM affiliates a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id = ?
      LIMIT 1
    `,
    [id],
  );

  if (!row) return null;

  const affiliate = parseAffiliate(row);
  affiliate.user = row.user_id
    ? {
        id: Number(row.user_id),
        first_name: row.u_first_name || null,
        last_name: row.u_last_name || null,
        phone: row.u_phone || null,
        role: row.u_role || null,
      }
    : null;

  return affiliate;
}

async function insertAffiliateClick(conn, payload) {
  const colsDef = await detectAffiliateClickCols(conn);
  const cols = [];
  const vals = [];
  const qs = [];

  if (colsDef.affiliate_id) {
    cols.push("affiliate_id");
    vals.push(payload.affiliate_id);
    qs.push("?");
  }

  if (colsDef.affiliate_code) {
    cols.push("affiliate_code");
    vals.push(payload.affiliate_code || null);
    qs.push("?");
  }

  if (colsDef.product_id) {
    cols.push("product_id");
    vals.push(payload.product_id || null);
    qs.push("?");
  }

  if (colsDef.ip_address) {
    cols.push("ip_address");
    vals.push(payload.ip_address || null);
    qs.push("?");
  }

  if (colsDef.user_agent) {
    cols.push("user_agent");
    vals.push(payload.user_agent || null);
    qs.push("?");
  }

  if (colsDef.referer_url) {
    cols.push("referer_url");
    vals.push(payload.referer_url || null);
    qs.push("?");
  }

  if (colsDef.landing_url) {
    cols.push("landing_url");
    vals.push(payload.landing_url || null);
    qs.push("?");
  }

  if (colsDef.source) {
    cols.push("source");
    vals.push(payload.source || null);
    qs.push("?");
  }

  if (colsDef.device) {
    cols.push("device");
    vals.push(payload.device || null);
    qs.push("?");
  }

  if (colsDef.created_at) {
    cols.push("created_at");
    qs.push("NOW()");
  }

  if (!cols.length) return;

  await conn.query(
    `INSERT INTO affiliate_clicks (${cols.join(", ")}) VALUES (${qs.join(", ")})`,
    vals,
  );
}

async function syncAffiliateCounters(conn, affiliateId) {
  const [[clicksRow]] = await conn.query(
    `
      SELECT COUNT(*) AS clicks_count
      FROM affiliate_clicks
      WHERE affiliate_id = ?
    `,
    [affiliateId],
  );

  const [[commRow]] = await conn.query(
    `
      SELECT
        COUNT(DISTINCT order_id) AS orders_count,
        COALESCE(SUM(CASE WHEN status <> 'CANCELLED' THEN amount ELSE 0 END), 0) AS earnings_total
      FROM affiliate_commissions
      WHERE affiliate_id = ?
    `,
    [affiliateId],
  );

  await conn.query(
    `
      UPDATE affiliates
      SET
        total_clicks = ?,
        total_orders = ?,
        total_earnings = ?,
        updated_at = NOW()
      WHERE id = ?
    `,
    [
      Number(clicksRow?.clicks_count || 0),
      Number(commRow?.orders_count || 0),
      Number(commRow?.earnings_total || 0),
      affiliateId,
    ],
  );
}

async function upsertAffiliateRevenueReport(
  conn,
  { affiliateId = null, periodType, periodKey, periodStart, periodEnd },
) {
  const reportAffiliateId = affiliateId == null ? 0 : Number(affiliateId);

  const [[clickRow]] = await conn.query(
    `
      SELECT COUNT(*) AS clicks_count
      FROM affiliate_clicks
      WHERE (? = 0 OR affiliate_id = ?)
        AND DATE(created_at) BETWEEN ? AND ?
    `,
    [reportAffiliateId, reportAffiliateId, periodStart, periodEnd],
  );

  const [[commRow]] = await conn.query(
    `
      SELECT
        COUNT(DISTINCT order_id) AS orders_count,
        COALESCE(SUM(base_amount), 0) AS sales_amount,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN amount ELSE 0 END), 0) AS commission_pending,
        COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN amount ELSE 0 END), 0) AS commission_approved,
        COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END), 0) AS commission_paid,
        COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN amount ELSE 0 END), 0) AS commission_cancelled,
        COALESCE(SUM(CASE WHEN status <> 'CANCELLED' THEN amount ELSE 0 END), 0) AS commission_total
      FROM affiliate_commissions
      WHERE (? = 0 OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
    `,
    [reportAffiliateId, reportAffiliateId, periodStart, periodEnd],
  );

  await conn.query(
    `
      INSERT INTO affiliate_revenue_reports (
        affiliate_id,
        period_type,
        period_key,
        period_start,
        period_end,
        clicks_count,
        orders_count,
        sales_amount,
        commission_pending,
        commission_approved,
        commission_paid,
        commission_cancelled,
        commission_total,
        currency,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MAD', NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        clicks_count = VALUES(clicks_count),
        orders_count = VALUES(orders_count),
        sales_amount = VALUES(sales_amount),
        commission_pending = VALUES(commission_pending),
        commission_approved = VALUES(commission_approved),
        commission_paid = VALUES(commission_paid),
        commission_cancelled = VALUES(commission_cancelled),
        commission_total = VALUES(commission_total),
        updated_at = NOW()
    `,
    [
      reportAffiliateId,
      periodType,
      periodKey,
      periodStart,
      periodEnd,
      Number(clickRow?.clicks_count || 0),
      Number(commRow?.orders_count || 0),
      Number(commRow?.sales_amount || 0),
      Number(commRow?.commission_pending || 0),
      Number(commRow?.commission_approved || 0),
      Number(commRow?.commission_paid || 0),
      Number(commRow?.commission_cancelled || 0),
      Number(commRow?.commission_total || 0),
    ],
  );
}

async function ensureCurrentReports(conn, affiliateId = null) {
  for (const type of PERIOD_TYPES) {
    const meta = periodMeta(type, new Date());

    await upsertAffiliateRevenueReport(conn, {
      affiliateId,
      periodType: meta.period_type,
      periodKey: meta.period_key,
      periodStart: meta.period_start,
      periodEnd: meta.period_end,
    });
  }
}

async function rebuildAffiliateReports(conn, affiliateId = null, from = null, to = null) {
  const startDate = toDateOnly(from) || "2024-01-01";
  const endDate = toDateOnly(to) || toDateOnly(new Date());

  const [dayRows] = await conn.query(
    `
      SELECT DISTINCT period_day AS period_key
      FROM affiliate_commissions
      WHERE period_day IS NOT NULL
        AND (? IS NULL OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
      UNION
      SELECT DISTINCT DATE(created_at) AS period_key
      FROM affiliate_clicks
      WHERE (? IS NULL OR affiliate_id = ?)
        AND DATE(created_at) BETWEEN ? AND ?
      ORDER BY period_key ASC
    `,
    [
      affiliateId,
      affiliateId,
      startDate,
      endDate,
      affiliateId,
      affiliateId,
      startDate,
      endDate,
    ],
  );

  const [weekRows] = await conn.query(
    `
      SELECT DISTINCT period_week_start AS period_key
      FROM affiliate_commissions
      WHERE period_week_start IS NOT NULL
        AND (? IS NULL OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
      ORDER BY period_key ASC
    `,
    [affiliateId, affiliateId, startDate, endDate],
  );

  const [monthRows] = await conn.query(
    `
      SELECT DISTINCT period_month AS period_key
      FROM affiliate_commissions
      WHERE period_month IS NOT NULL
        AND (? IS NULL OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
      ORDER BY period_key ASC
    `,
    [affiliateId, affiliateId, startDate, endDate],
  );

  const [yearRows] = await conn.query(
    `
      SELECT DISTINCT period_year AS period_key
      FROM affiliate_commissions
      WHERE period_year IS NOT NULL
        AND (? IS NULL OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
      ORDER BY period_key ASC
    `,
    [affiliateId, affiliateId, startDate, endDate],
  );

  for (const row of dayRows || []) {
    const meta = periodMeta("DAY", row.period_key);
    await upsertAffiliateRevenueReport(conn, {
      affiliateId,
      periodType: "DAY",
      periodKey: meta.period_key,
      periodStart: meta.period_start,
      periodEnd: meta.period_end,
    });
  }

  for (const row of weekRows || []) {
    const meta = periodMeta("WEEK", row.period_key);
    await upsertAffiliateRevenueReport(conn, {
      affiliateId,
      periodType: "WEEK",
      periodKey: meta.period_key,
      periodStart: meta.period_start,
      periodEnd: meta.period_end,
    });
  }

  for (const row of monthRows || []) {
    const meta = periodMeta("MONTH", `${row.period_key}-01`);
    await upsertAffiliateRevenueReport(conn, {
      affiliateId,
      periodType: "MONTH",
      periodKey: meta.period_key,
      periodStart: meta.period_start,
      periodEnd: meta.period_end,
    });
  }

  for (const row of yearRows || []) {
    const meta = periodMeta("YEAR", `${row.period_key}-01-01`);
    await upsertAffiliateRevenueReport(conn, {
      affiliateId,
      periodType: "YEAR",
      periodKey: meta.period_key,
      periodStart: meta.period_start,
      periodEnd: meta.period_end,
    });
  }

  await ensureCurrentReports(conn, affiliateId);

  if (affiliateId) {
    await syncAffiliateCounters(conn, affiliateId);
  }
}

/* =========================
 * Reporting global summary
 * GET /api/affiliates/reports/summary
 * =======================*/
router.get("/reports/summary", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const period = normPeriodType(req.query.period, "MONTH");
  const conn = await getPool().getConnection();

  try {
    await ensureCurrentReports(conn, null);
    const meta = periodMeta(period, new Date());

    const [[row]] = await conn.query(
      `
        SELECT *
        FROM affiliate_revenue_reports
        WHERE affiliate_id = 0
          AND period_type = ?
          AND period_key = ?
        LIMIT 1
      `,
      [period, meta.period_key],
    );

    return res.json({
      period,
      global: row || {
        affiliate_id: null,
        period_type: period,
        period_key: meta.period_key,
        period_start: meta.period_start,
        period_end: meta.period_end,
        clicks_count: 0,
        orders_count: 0,
        sales_amount: 0,
        commission_pending: 0,
        commission_approved: 0,
        commission_paid: 0,
        commission_cancelled: 0,
        commission_total: 0,
        currency: "MAD",
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Reporting global history
 * GET /api/affiliates/reports/history
 * =======================*/
router.get("/reports/history", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const period = normPeriodType(req.query.period, "MONTH");
  const { page, pageSize, offset, limit } = getPagination(req);

  try {
    const [[{ total }]] = await getPool().query(
      `
        SELECT COUNT(*) AS total
        FROM affiliate_revenue_reports
        WHERE affiliate_id = 0
          AND period_type = ?
      `,
      [period],
    );

    const [rows] = await getPool().query(
      `
        SELECT *
        FROM affiliate_revenue_reports
        WHERE affiliate_id = 0
          AND period_type = ?
        ORDER BY period_start DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [period, limit, offset],
    );

    return res.json({
      items: rows || [],
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Rebuild reports
 * POST /api/affiliates/reports/rebuild
 * =======================*/
router.post("/reports/rebuild", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const affiliateId =
    req.body?.affiliate_id == null || req.body?.affiliate_id === ""
      ? null
      : Number(req.body.affiliate_id);

  if (
    affiliateId !== null &&
    (!Number.isFinite(affiliateId) || affiliateId <= 0)
  ) {
    return res.status(400).json({ error: "affiliate_id invalide" });
  }

  const from = req.body?.from || null;
  const to = req.body?.to || null;

  const conn = await getPool().getConnection();

  try {
    await conn.beginTransaction();

    if (affiliateId) {
      await rebuildAffiliateReports(conn, affiliateId, from, to);
    } else {
      const [rows] = await conn.query(`SELECT id FROM affiliates`);
      for (const row of rows || []) {
        await rebuildAffiliateReports(conn, Number(row.id), from, to);
      }
      await rebuildAffiliateReports(conn, null, from, to);
    }

    await conn.commit();

    return res.json({
      success: true,
      affiliate_id: affiliateId,
      from: toDateOnly(from) || null,
      to: toDateOnly(to) || null,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin update commission status
 * PUT /api/affiliates/commissions/:id/status
 * =======================*/
router.put("/commissions/:id/status", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const status = normCommissionStatus(req.body?.status, "");
  if (!COMMISSION_STATUSES.includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }

  const conn = await getPool().getConnection();

  try {
    await conn.beginTransaction();

    const sets = ["status = ?"];
    const vals = [status];

    if (status === "PAID") {
      sets.push("paid_at = NOW()");
    } else {
      sets.push("paid_at = NULL");
    }

    sets.push("updated_at = NOW()");

    const [r] = await conn.query(
      `
        UPDATE affiliate_commissions
        SET ${sets.join(", ")}
        WHERE id = ?
      `,
      [...vals, id],
    );

    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: "Not found" });
    }

    const [[row]] = await conn.query(
      `
        SELECT *
        FROM affiliate_commissions
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );

    await syncAffiliateCounters(conn, Number(row.affiliate_id));
    await rebuildAffiliateReports(conn, Number(row.affiliate_id));
    await rebuildAffiliateReports(conn, null);

    await conn.commit();

    return res.json(row);
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Public tracking by code
 * GET /api/affiliates/track/:code
 * =======================*/
router.get("/track/:code", async (req, res) => {
  const code = normalizeAffiliateCode(req.params.code);

  if (!code) {
    return res.status(400).json({ error: "invalid code" });
  }

  const landing = !isBlank(req.query.to) ? String(req.query.to).trim() : "/";
  const safeLanding = buildSafeLandingUrl(landing);

  const productId =
    normalizeProductId(req.query.product_id) ||
    normalizeProductId(req.query.productId) ||
    normalizeProductId(req.query.pid) ||
    extractProductIdFromLanding(landing);

  const source = extractSource(req, landing);
  const device = detectDevice(req.headers["user-agent"] || null);

  const conn = await getPool().getConnection();

  try {
    const [[affiliate]] = await conn.query(
      `
        SELECT *
        FROM affiliates
        WHERE affiliate_code = ?
          AND status = 'ACTIVE'
        LIMIT 1
      `,
      [code],
    );

    if (!affiliate) {
      return res.redirect(safeLanding);
    }

    await conn.beginTransaction();

    await insertAffiliateClick(conn, {
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.affiliate_code,
      product_id: productId,
      ip_address: getClientIp(req),
      user_agent: req.headers["user-agent"] || null,
      referer_url: req.headers.referer || null,
      landing_url: landing,
      source,
      device,
    });

    await syncAffiliateCounters(conn, Number(affiliate.id));
    await rebuildAffiliateReports(conn, Number(affiliate.id));
    await rebuildAffiliateReports(conn, null);

    await conn.commit();

    const sep = safeLanding.includes("?") ? "&" : "?";
    return res.redirect(`${safeLanding}${sep}ref=${encodeURIComponent(code)}`);
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.redirect(publicWebBase());
  } finally {
    conn.release();
  }
});

/* =========================
 * Public tracking by slug
 * GET /api/affiliates/ref/:slug
 * =======================*/
router.get("/ref/:slug", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);

  if (!slug) {
    return res.redirect(publicWebBase());
  }

  const landing = !isBlank(req.query.to) ? String(req.query.to).trim() : "/";
  const safeLanding = buildSafeLandingUrl(landing);

  const productId =
    normalizeProductId(req.query.product_id) ||
    normalizeProductId(req.query.productId) ||
    normalizeProductId(req.query.pid) ||
    extractProductIdFromLanding(landing);

  const source = extractSource(req, landing);
  const device = detectDevice(req.headers["user-agent"] || null);

  const conn = await getPool().getConnection();

  try {
    const [[affiliate]] = await conn.query(
      `
        SELECT *
        FROM affiliates
        WHERE referral_slug = ?
          AND status = 'ACTIVE'
        LIMIT 1
      `,
      [slug],
    );

    if (!affiliate) {
      return res.redirect(safeLanding);
    }

    await conn.beginTransaction();

    await insertAffiliateClick(conn, {
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.affiliate_code,
      product_id: productId,
      ip_address: getClientIp(req),
      user_agent: req.headers["user-agent"] || null,
      referer_url: req.headers.referer || null,
      landing_url: landing,
      source,
      device,
    });

    await syncAffiliateCounters(conn, Number(affiliate.id));
    await rebuildAffiliateReports(conn, Number(affiliate.id));
    await rebuildAffiliateReports(conn, null);

    await conn.commit();

    const sep = safeLanding.includes("?") ? "&" : "?";

    return res.redirect(
      `${safeLanding}${sep}ref=${encodeURIComponent(affiliate.affiliate_code)}`,
    );
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.redirect(publicWebBase());
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin list affiliates
 * GET /api/affiliates
 * =======================*/
router.get("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const pool = getPool();
  const { page, pageSize, offset, limit } = getPagination(req);
  const q = String(req.query.q || "").trim();
  const status = req.query.status ? normStatus(req.query.status, "") : null;
  const userId = req.query.user_id ? Number(req.query.user_id) : null;

  try {
    const userSelectCols = await buildAffiliateUserSelect(pool);
    let where = "1=1";
    const params = [];

    if (status && ["ACTIVE", "INACTIVE"].includes(status)) {
      where += " AND a.status = ?";
      params.push(status);
    }

    if (userId && Number.isFinite(userId) && userId > 0) {
      where += " AND a.user_id = ?";
      params.push(userId);
    }

    if (q) {
      where += `
        AND (
          a.affiliate_code LIKE ?
          OR a.referral_slug LIKE ?
          OR a.name LIKE ?
          OR a.phone LIKE ?
          OR CAST(a.user_id AS CHAR) LIKE ?
        )
      `;
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }

    const [[{ total }]] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM affiliates a
        WHERE ${where}
      `,
      params,
    );

    const [rows] = await pool.query(
      `
        SELECT
          a.*,
          ${userSelectCols.join(", ")}
        FROM affiliates a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    const items = (rows || []).map((row) => {
      const affiliate = parseAffiliate(row);
      affiliate.user = row.user_id
        ? {
            id: Number(row.user_id),
            first_name: row.u_first_name || null,
            last_name: row.u_last_name || null,
            phone: row.u_phone || null,
            role: row.u_role || null,
          }
        : null;
      return affiliate;
    });

    return res.json({
      items,
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Admin create affiliate
 * POST /api/affiliates
 * =======================*/
router.post("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const {
    user_id = null,
    affiliate_code = null,
    referral_slug = null,
    name = null,
    phone = null,
    commission_rate = 10,
    status = "ACTIVE",
    notes = null,
  } = req.body || {};

  const userId =
    user_id !== null && user_id !== undefined && user_id !== ""
      ? Number(user_id)
      : null;

  if (userId !== null && (!Number.isFinite(userId) || userId <= 0)) {
    return res.status(400).json({ error: "user_id invalide" });
  }

  const conn = await getPool().getConnection();

  try {
    await conn.beginTransaction();

    if (userId !== null) {
      const [[existing]] = await conn.query(
        "SELECT id FROM affiliates WHERE user_id = ? LIMIT 1",
        [userId],
      );
      if (existing) {
        await conn.rollback();
        return res.status(409).json({
          code: "AFFILIATE_USER_EXISTS",
          message: "Cet utilisateur est déjà affilié.",
          affiliate_id: existing.id,
        });
      }
    }

    let code = normalizeAffiliateCode(affiliate_code);
    let slug = normalizeSlug(referral_slug);
    const cleanStatus = normStatus(status, "ACTIVE");
    const rate = normRate(commission_rate, 10);

    if (!code) {
      code = await generateUniqueAffiliateCode(conn, "DUU");
    } else {
      const exists = await affiliateExistsByCode(conn, code);
      if (exists) {
        await conn.rollback();
        return res.status(409).json({
          code: "AFFILIATE_CODE_EXISTS",
          message: "Ce code affilié existe déjà.",
        });
      }
    }

    if (!slug) {
      slug = await generateUniqueSlug(conn, name || code);
    } else {
      const exists = await affiliateExistsBySlug(conn, slug);
      if (exists) {
        await conn.rollback();
        return res.status(409).json({
          code: "AFFILIATE_SLUG_EXISTS",
          message: "Ce slug affilié existe déjà.",
        });
      }
    }

    const [result] = await conn.query(
      `
        INSERT INTO affiliates (
          user_id,
          affiliate_code,
          referral_slug,
          name,
          phone,
          commission_rate,
          status,
          total_clicks,
          total_orders,
          total_earnings,
          notes,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NOW(), NOW())
      `,
      [
        userId,
        code,
        slug,
        !isBlank(name) ? String(name).trim() : null,
        !isBlank(phone) ? normPhone(phone) || String(phone).trim() : null,
        rate,
        cleanStatus,
        !isBlank(notes) ? String(notes).trim() : null,
      ],
    );

    const affiliate = await findAffiliateById(conn, result.insertId);

    await ensureCurrentReports(conn, Number(result.insertId));
    await syncAffiliateCounters(conn, Number(result.insertId));

    await conn.commit();

    return res.status(201).json(affiliate);
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin get affiliate dashboard
 * GET /api/affiliates/:id/dashboard
 * =======================*/
router.get("/:id/dashboard", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const conn = await getPool().getConnection();

  try {
    const affiliate = await findAffiliateById(conn, id);
    if (!affiliate) {
      return res.status(404).json({ error: "Not found" });
    }

    await ensureCurrentReports(conn, id);

    const metas = {
      today: periodMeta("DAY"),
      week: periodMeta("WEEK"),
      month: periodMeta("MONTH"),
      year: periodMeta("YEAR"),
    };

    const fetchRow = async (periodType, periodKey) => {
      const [[row]] = await conn.query(
        `
          SELECT *
          FROM affiliate_revenue_reports
          WHERE affiliate_id = ?
            AND period_type = ?
            AND period_key = ?
          LIMIT 1
        `,
        [id, periodType, periodKey],
      );

      return row || null;
    };

    const today = await fetchRow("DAY", metas.today.period_key);
    const week = await fetchRow("WEEK", metas.week.period_key);
    const month = await fetchRow("MONTH", metas.month.period_key);
    const year = await fetchRow("YEAR", metas.year.period_key);

    const [recentMonths] = await conn.query(
      `
        SELECT *
        FROM affiliate_revenue_reports
        WHERE affiliate_id = ?
          AND period_type = 'MONTH'
        ORDER BY period_start DESC, id DESC
        LIMIT 12
      `,
      [id],
    );

    return res.json({
      affiliate,
      today: today || {},
      week: week || {},
      month: month || {},
      year: year || {},
      recent_months: recentMonths || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin get affiliate history
 * GET /api/affiliates/:id/reports/history
 * =======================*/
router.get("/:id/reports/history", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const period = normPeriodType(req.query.period, "MONTH");
  const { page, pageSize, offset, limit } = getPagination(req);

  try {
    const [[{ total }]] = await getPool().query(
      `
        SELECT COUNT(*) AS total
        FROM affiliate_revenue_reports
        WHERE affiliate_id = ?
          AND period_type = ?
      `,
      [id, period],
    );

    const [rows] = await getPool().query(
      `
        SELECT *
        FROM affiliate_revenue_reports
        WHERE affiliate_id = ?
          AND period_type = ?
        ORDER BY period_start DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [id, period, limit, offset],
    );

    return res.json({
      items: rows || [],
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Admin get one affiliate
 * GET /api/affiliates/:id
 * =======================*/
router.get("/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const conn = await getPool().getConnection();

  try {
    const affiliate = await findAffiliateById(conn, id);
    if (!affiliate) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(affiliate);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin update affiliate
 * PUT /api/affiliates/:id
 * =======================*/
router.put("/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const {
    user_id,
    affiliate_code,
    referral_slug,
    name,
    phone,
    commission_rate,
    status,
    notes,
  } = req.body || {};

  const conn = await getPool().getConnection();

  try {
    await conn.beginTransaction();

    const existing = await findAffiliateById(conn, id);
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ error: "Not found" });
    }

    const sets = [];
    const vals = [];

    if (user_id !== undefined) {
      const userId = user_id === null || user_id === "" ? null : Number(user_id);

      if (userId !== null && (!Number.isFinite(userId) || userId <= 0)) {
        await conn.rollback();
        return res.status(400).json({ error: "user_id invalide" });
      }

      sets.push("user_id = ?");
      vals.push(userId);
    }

    if (affiliate_code !== undefined) {
      const code = normalizeAffiliateCode(affiliate_code);

      if (!code) {
        await conn.rollback();
        return res.status(400).json({ error: "affiliate_code requis" });
      }

      const exists = await affiliateExistsByCode(conn, code, id);

      if (exists) {
        await conn.rollback();
        return res.status(409).json({
          code: "AFFILIATE_CODE_EXISTS",
          message: "Ce code affilié existe déjà.",
        });
      }

      sets.push("affiliate_code = ?");
      vals.push(code);
    }

    if (referral_slug !== undefined) {
      const slug = normalizeSlug(referral_slug);

      if (!slug) {
        await conn.rollback();
        return res.status(400).json({ error: "referral_slug invalide" });
      }

      const exists = await affiliateExistsBySlug(conn, slug, id);

      if (exists) {
        await conn.rollback();
        return res.status(409).json({
          code: "AFFILIATE_SLUG_EXISTS",
          message: "Ce slug affilié existe déjà.",
        });
      }

      sets.push("referral_slug = ?");
      vals.push(slug);
    }

    if (name !== undefined) {
      sets.push("name = ?");
      vals.push(!isBlank(name) ? String(name).trim() : null);
    }

    if (phone !== undefined) {
      sets.push("phone = ?");
      vals.push(!isBlank(phone) ? normPhone(phone) || String(phone).trim() : null);
    }

    if (commission_rate !== undefined) {
      sets.push("commission_rate = ?");
      vals.push(normRate(commission_rate, existing.commission_rate || 10));
    }

    if (status !== undefined) {
      sets.push("status = ?");
      vals.push(normStatus(status, existing.status || "ACTIVE"));
    }

    if (notes !== undefined) {
      sets.push("notes = ?");
      vals.push(!isBlank(notes) ? String(notes).trim() : null);
    }

    if (!sets.length) {
      await conn.rollback();
      return res.status(400).json({ error: "Aucune modification fournie." });
    }

    sets.push("updated_at = NOW()");

    await conn.query(
      `UPDATE affiliates SET ${sets.join(", ")} WHERE id = ?`,
      [...vals, id],
    );

    const affiliate = await findAffiliateById(conn, id);

    await conn.commit();

    return res.json(affiliate);
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Admin quick status update
 * PUT /api/affiliates/:id/status
 * =======================*/
router.put("/:id/status", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const nextStatus = normStatus(req.body?.status, "ACTIVE");

  try {
    const [r] = await getPool().query(
      `
        UPDATE affiliates
        SET status = ?, updated_at = NOW()
        WHERE id = ?
      `,
      [nextStatus, id],
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "Not found" });
    }

    const conn = await getPool().getConnection();

    try {
      const affiliate = await findAffiliateById(conn, id);
      return res.json(affiliate);
    } finally {
      conn.release();
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Admin affiliate commissions
 * GET /api/affiliates/:id/commissions
 * =======================*/
router.get("/:id/commissions", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const { page, pageSize, offset, limit } = getPagination(req);
  const status = req.query.status
    ? normCommissionStatus(req.query.status, "")
    : null;

  try {
    let where = "affiliate_id = ?";
    const params = [id];

    if (status && COMMISSION_STATUSES.includes(status)) {
      where += " AND status = ?";
      params.push(status);
    }

    const [[{ total }]] = await getPool().query(
      `
        SELECT COUNT(*) AS total
        FROM affiliate_commissions
        WHERE ${where}
      `,
      params,
    );

    const [rows] = await getPool().query(
      `
        SELECT *
        FROM affiliate_commissions
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    return res.json({
      items: rows || [],
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Admin affiliate clicks
 * GET /api/affiliates/:id/clicks
 * =======================*/
router.get("/:id/clicks", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  const { page, pageSize, offset, limit } = getPagination(req);

  try {
    const [[{ total }]] = await getPool().query(
      `
        SELECT COUNT(*) AS total
        FROM affiliate_clicks
        WHERE affiliate_id = ?
      `,
      [id],
    );

    const [rows] = await getPool().query(
      `
        SELECT *
        FROM affiliate_clicks
        WHERE affiliate_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [id, limit, offset],
    );

    return res.json({
      items: rows || [],
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;