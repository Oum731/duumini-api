const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired } = require("../middlewares/auth");

const router = Router();

const REPORT_TABLE = "affiliate_revenue_reports";
const COMMISSION_STATUSES = ["PENDING", "APPROVED", "PAID", "CANCELLED"];
const PERIOD_TYPES = ["DAY", "WEEK", "MONTH", "YEAR"];

function toPosInt(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toPage(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toPageSize(value, fallback = 10, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function normPeriod(value, fallback = "MONTH") {
  const v = String(value || fallback).trim().toUpperCase();
  return PERIOD_TYPES.includes(v) ? v : fallback;
}

function normCommissionStatus(value) {
  const v = String(value || "").trim().toUpperCase();
  return COMMISSION_STATUSES.includes(v) ? v : null;
}

function emptyStats() {
  return {
    clicks_count: 0,
    orders_count: 0,
    sales_amount: 0,
    commission_pending: 0,
    commission_approved: 0,
    commission_paid: 0,
    commission_cancelled: 0,
    commission_total: 0,
  };
}

async function getAffiliateByUserId(pool, userId) {
  const [rows] = await pool.query(
    `
      SELECT *
      FROM affiliates
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId],
  );

  return rows && rows[0] ? rows[0] : null;
}

async function getCurrentAffiliate(req, res) {
  const pool = getPool();
  const userId = toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const affiliate = await getAffiliateByUserId(pool, userId);

  if (!affiliate) {
    res.status(404).json({ error: "Not affiliate" });
    return null;
  }

  return {
    pool,
    userId,
    affiliate,
    affiliateId: Number(affiliate.id),
  };
}

/**
 * GET /api/affiliate/me
 */
router.get("/me", authRequired, async (req, res) => {
  try {
    const pool = getPool();
    const userId = toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const affiliate = await getAffiliateByUserId(pool, userId);

    return res.json({
      is_affiliate: !!affiliate,
      affiliate,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Impossible de charger le profil affilié.",
    });
  }
});

/**
 * GET /api/affiliate/me/dashboard
 */
router.get("/me/dashboard", authRequired, async (req, res) => {
  try {
    const ctx = await getCurrentAffiliate(req, res);
    if (!ctx) return;

    const { pool, affiliate, affiliateId } = ctx;

    const [dashboardRows] = await pool.query(
      `
        SELECT
          COALESCE(SUM(clicks_count), 0) AS clicks_count,
          COALESCE(SUM(orders_count), 0) AS orders_count,
          COALESCE(SUM(sales_amount), 0) AS sales_amount,
          COALESCE(SUM(commission_pending), 0) AS commission_pending,
          COALESCE(SUM(commission_approved), 0) AS commission_approved,
          COALESCE(SUM(commission_paid), 0) AS commission_paid,
          COALESCE(SUM(commission_cancelled), 0) AS commission_cancelled,
          COALESCE(SUM(commission_total), 0) AS commission_total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
      `,
      [affiliateId],
    );

    const [todayRows] = await pool.query(
      `
        SELECT
          COALESCE(SUM(clicks_count), 0) AS clicks_count,
          COALESCE(SUM(orders_count), 0) AS orders_count,
          COALESCE(SUM(sales_amount), 0) AS sales_amount,
          COALESCE(SUM(commission_pending), 0) AS commission_pending,
          COALESCE(SUM(commission_approved), 0) AS commission_approved,
          COALESCE(SUM(commission_paid), 0) AS commission_paid,
          COALESCE(SUM(commission_cancelled), 0) AS commission_cancelled,
          COALESCE(SUM(commission_total), 0) AS commission_total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND period_type = 'DAY'
          AND DATE(period_start) = CURDATE()
      `,
      [affiliateId],
    );

    const [weekRows] = await pool.query(
      `
        SELECT
          COALESCE(SUM(clicks_count), 0) AS clicks_count,
          COALESCE(SUM(orders_count), 0) AS orders_count,
          COALESCE(SUM(sales_amount), 0) AS sales_amount,
          COALESCE(SUM(commission_pending), 0) AS commission_pending,
          COALESCE(SUM(commission_approved), 0) AS commission_approved,
          COALESCE(SUM(commission_paid), 0) AS commission_paid,
          COALESCE(SUM(commission_cancelled), 0) AS commission_cancelled,
          COALESCE(SUM(commission_total), 0) AS commission_total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND period_type = 'WEEK'
          AND YEARWEEK(period_start, 1) = YEARWEEK(CURDATE(), 1)
      `,
      [affiliateId],
    );

    const [monthRows] = await pool.query(
      `
        SELECT
          COALESCE(SUM(clicks_count), 0) AS clicks_count,
          COALESCE(SUM(orders_count), 0) AS orders_count,
          COALESCE(SUM(sales_amount), 0) AS sales_amount,
          COALESCE(SUM(commission_pending), 0) AS commission_pending,
          COALESCE(SUM(commission_approved), 0) AS commission_approved,
          COALESCE(SUM(commission_paid), 0) AS commission_paid,
          COALESCE(SUM(commission_cancelled), 0) AS commission_cancelled,
          COALESCE(SUM(commission_total), 0) AS commission_total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND period_type = 'MONTH'
          AND DATE_FORMAT(period_start, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')
      `,
      [affiliateId],
    );

    const [yearRows] = await pool.query(
      `
        SELECT
          COALESCE(SUM(clicks_count), 0) AS clicks_count,
          COALESCE(SUM(orders_count), 0) AS orders_count,
          COALESCE(SUM(sales_amount), 0) AS sales_amount,
          COALESCE(SUM(commission_pending), 0) AS commission_pending,
          COALESCE(SUM(commission_approved), 0) AS commission_approved,
          COALESCE(SUM(commission_paid), 0) AS commission_paid,
          COALESCE(SUM(commission_cancelled), 0) AS commission_cancelled,
          COALESCE(SUM(commission_total), 0) AS commission_total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND period_type = 'YEAR'
          AND YEAR(period_start) = YEAR(CURDATE())
      `,
      [affiliateId],
    );

    return res.json({
      affiliate,
      global: dashboardRows?.[0] || emptyStats(),
      today: todayRows?.[0] || emptyStats(),
      week: weekRows?.[0] || emptyStats(),
      month: monthRows?.[0] || emptyStats(),
      year: yearRows?.[0] || emptyStats(),
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Impossible de charger le dashboard affilié.",
    });
  }
});

/**
 * GET /api/affiliate/me/commissions
 */
router.get("/me/commissions", authRequired, async (req, res) => {
  try {
    const ctx = await getCurrentAffiliate(req, res);
    if (!ctx) return;

    const { pool, affiliateId } = ctx;
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 10, 100);
    const status = normCommissionStatus(req.query.status);

    const where = ["affiliate_id = ?"];
    const params = [affiliateId];

    if (status) {
      where.push("status = ?");
      params.push(status);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM affiliate_commissions ${whereSql}`,
      params,
    );

    const [items] = await pool.query(
      `
        SELECT *
        FROM affiliate_commissions
        ${whereSql}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset],
    );

    return res.json({
      items: items || [],
      pageInfo: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasPrevPage: page > 1,
        hasNextPage: offset + pageSize < total,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Impossible de charger les commissions.",
    });
  }
});

/**
 * GET /api/affiliate/me/clicks
 */
router.get("/me/clicks", authRequired, async (req, res) => {
  try {
    const ctx = await getCurrentAffiliate(req, res);
    if (!ctx) return;

    const { pool, affiliateId } = ctx;
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 10, 100);
    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM affiliate_clicks WHERE affiliate_id = ?`,
      [affiliateId],
    );

    const [items] = await pool.query(
      `
        SELECT *
        FROM affiliate_clicks
        WHERE affiliate_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `,
      [affiliateId, pageSize, offset],
    );

    return res.json({
      items: items || [],
      pageInfo: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasPrevPage: page > 1,
        hasNextPage: offset + pageSize < total,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Impossible de charger les clics.",
    });
  }
});

/**
 * GET /api/affiliate/me/history
 */
router.get("/me/history", authRequired, async (req, res) => {
  try {
    const ctx = await getCurrentAffiliate(req, res);
    if (!ctx) return;

    const { pool, affiliateId } = ctx;
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 12, 100);
    const finalPeriod = normPeriod(req.query.period, "MONTH");
    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND UPPER(period_type) = ?
      `,
      [affiliateId, finalPeriod],
    );

    const [items] = await pool.query(
      `
        SELECT *
        FROM ${REPORT_TABLE}
        WHERE affiliate_id = ?
          AND UPPER(period_type) = ?
        ORDER BY period_start DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [affiliateId, finalPeriod, pageSize, offset],
    );

    return res.json({
      items: items || [],
      pageInfo: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasPrevPage: page > 1,
        hasNextPage: offset + pageSize < total,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Impossible de charger l'historique affilié.",
    });
  }
});

module.exports = router;