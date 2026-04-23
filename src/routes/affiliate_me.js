const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired } = require("../middlewares/auth");

const router = Router();

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

async function getAffiliateByUserId(pool, userId) {
  const [rows] = await pool.query(
    `
    SELECT *
    FROM affiliates
    WHERE user_id=?
    LIMIT 1
    `,
    [userId]
  );

  return rows && rows[0] ? rows[0] : null;
}

/**
 * GET /api/affiliate/me
 */
router.get("/me", authRequired, async (req, res) => {
  try {
    const pool = getPool();
    const userId =
      toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

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
    const pool = getPool();
    const userId =
      toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const affiliate = await getAffiliateByUserId(pool, userId);

    if (!affiliate) {
      return res.status(404).json({ error: "Not affiliate" });
    }

    const affiliateId = Number(affiliate.id);

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
      FROM affiliate_reports
      WHERE affiliate_id=?
      `,
      [affiliateId]
    );

    const global = dashboardRows && dashboardRows[0] ? dashboardRows[0] : {
      clicks_count: 0,
      orders_count: 0,
      sales_amount: 0,
      commission_pending: 0,
      commission_approved: 0,
      commission_paid: 0,
      commission_cancelled: 0,
      commission_total: 0,
    };

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
      FROM affiliate_reports
      WHERE affiliate_id=? AND DATE(period_start)=CURDATE()
      `,
      [affiliateId]
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
      FROM affiliate_reports
      WHERE affiliate_id=? AND YEARWEEK(period_start, 1)=YEARWEEK(CURDATE(), 1)
      `,
      [affiliateId]
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
      FROM affiliate_reports
      WHERE affiliate_id=? AND DATE_FORMAT(period_start, '%Y-%m')=DATE_FORMAT(CURDATE(), '%Y-%m')
      `,
      [affiliateId]
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
      FROM affiliate_reports
      WHERE affiliate_id=? AND YEAR(period_start)=YEAR(CURDATE())
      `,
      [affiliateId]
    );

    return res.json({
      affiliate,
      global: global || {},
      today: (todayRows && todayRows[0]) || {},
      week: (weekRows && weekRows[0]) || {},
      month: (monthRows && monthRows[0]) || {},
      year: (yearRows && yearRows[0]) || {},
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
    const pool = getPool();
    const userId =
      toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const affiliate = await getAffiliateByUserId(pool, userId);

    if (!affiliate) {
      return res.status(404).json({ error: "Not affiliate" });
    }

    const affiliateId = Number(affiliate.id);
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 10, 100);
    const status = String(req.query.status || "").trim().toUpperCase();

    const where = ["affiliate_id=?"];
    const params = [affiliateId];

    if (status) {
      where.push("status=?");
      params.push(status);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM affiliate_commissions ${whereSql}`,
      params
    );

    const [items] = await pool.query(
      `
      SELECT *
      FROM affiliate_commissions
      ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
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
    const pool = getPool();
    const userId =
      toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const affiliate = await getAffiliateByUserId(pool, userId);

    if (!affiliate) {
      return res.status(404).json({ error: "Not affiliate" });
    }

    const affiliateId = Number(affiliate.id);
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 10, 100);
    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM affiliate_clicks WHERE affiliate_id=?`,
      [affiliateId]
    );

    const [items] = await pool.query(
      `
      SELECT *
      FROM affiliate_clicks
      WHERE affiliate_id=?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [affiliateId, pageSize, offset]
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
    const pool = getPool();
    const userId =
      toPosInt(req.user?.effective_user_id) || toPosInt(req.user?.id);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const affiliate = await getAffiliateByUserId(pool, userId);

    if (!affiliate) {
      return res.status(404).json({ error: "Not affiliate" });
    }

    const affiliateId = Number(affiliate.id);
    const page = toPage(req.query.page, 1);
    const pageSize = toPageSize(req.query.pageSize, 12, 100);
    const period = String(req.query.period || "MONTH").trim().toUpperCase();

    const allowedPeriods = ["DAY", "WEEK", "MONTH", "YEAR"];
    const finalPeriod = allowedPeriods.includes(period) ? period : "MONTH";

    const offset = (page - 1) * pageSize;

    const [[{ total }]] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM affiliate_reports
      WHERE affiliate_id=? AND UPPER(period_type)=?
      `,
      [affiliateId, finalPeriod]
    );

    const [items] = await pool.query(
      `
      SELECT *
      FROM affiliate_reports
      WHERE affiliate_id=? AND UPPER(period_type)=?
      ORDER BY period_start DESC, id DESC
      LIMIT ? OFFSET ?
      `,
      [affiliateId, finalPeriod, pageSize, offset]
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