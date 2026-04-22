const { getPool } = require("../lib/db");

const COMMISSION_STATUSES = ["PENDING", "APPROVED", "PAID", "CANCELLED"];

function normalizeAffiliateCode(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return v || null;
}

function computeAffiliateCommission(baseAmount, rate) {
  const base = Number(baseAmount || 0);
  const pct = Number(rate || 0);

  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;

  return +((base * pct) / 100).toFixed(2);
}

function normalizeProductId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeOrderItemId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
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
  const type = String(periodType || "MONTH").trim().toUpperCase();

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

function getCommissionPeriodMeta(baseDate = new Date()) {
  return {
    period_day: periodMeta("DAY", baseDate).period_key,
    period_week_start: periodMeta("WEEK", baseDate).period_key,
    period_month: periodMeta("MONTH", baseDate).period_key,
    period_year: periodMeta("YEAR", baseDate).period_key,
  };
}

async function detectAffiliateOrderCols(conn) {
  const candidates = [
    "affiliate_id",
    "affiliate_code",
    "affiliate_commission_rate",
    "affiliate_commission_amount",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    affiliate_code: found.has("affiliate_code"),
    affiliate_commission_rate: found.has("affiliate_commission_rate"),
    affiliate_commission_amount: found.has("affiliate_commission_amount"),
  };
}

async function detectAffiliateCommissionCols(conn) {
  const candidates = [
    "affiliate_id",
    "order_id",
    "order_item_id",
    "affiliate_code",
    "amount",
    "commission_rate",
    "base_amount",
    "status",
    "note",
    "product_id",
    "currency",
    "period_day",
    "period_week_start",
    "period_month",
    "period_year",
    "source",
    "paid_at",
    "created_at",
    "updated_at",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'affiliate_commissions'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    order_id: found.has("order_id"),
    order_item_id: found.has("order_item_id"),
    affiliate_code: found.has("affiliate_code"),
    amount: found.has("amount"),
    commission_rate: found.has("commission_rate"),
    base_amount: found.has("base_amount"),
    status: found.has("status"),
    note: found.has("note"),
    product_id: found.has("product_id"),
    currency: found.has("currency"),
    period_day: found.has("period_day"),
    period_week_start: found.has("period_week_start"),
    period_month: found.has("period_month"),
    period_year: found.has("period_year"),
    source: found.has("source"),
    paid_at: found.has("paid_at"),
    created_at: found.has("created_at"),
    updated_at: found.has("updated_at"),
  };
}

async function detectAffiliateRevenueReportCols(conn) {
  const candidates = [
    "affiliate_id",
    "period_type",
    "period_key",
    "period_start",
    "period_end",
    "clicks_count",
    "orders_count",
    "sales_amount",
    "commission_pending",
    "commission_approved",
    "commission_paid",
    "commission_cancelled",
    "commission_total",
    "currency",
    "created_at",
    "updated_at",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'affiliate_revenue_reports'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    period_type: found.has("period_type"),
    period_key: found.has("period_key"),
    period_start: found.has("period_start"),
    period_end: found.has("period_end"),
    clicks_count: found.has("clicks_count"),
    orders_count: found.has("orders_count"),
    sales_amount: found.has("sales_amount"),
    commission_pending: found.has("commission_pending"),
    commission_approved: found.has("commission_approved"),
    commission_paid: found.has("commission_paid"),
    commission_cancelled: found.has("commission_cancelled"),
    commission_total: found.has("commission_total"),
    currency: found.has("currency"),
    created_at: found.has("created_at"),
    updated_at: found.has("updated_at"),
  };
}

async function findActiveAffiliateByCode(conn, rawCode) {
  const code = normalizeAffiliateCode(rawCode);
  if (!code) return null;

  try {
    const [[row]] = await conn.query(
      `
        SELECT
          id,
          user_id,
          affiliate_code,
          referral_slug,
          commission_rate,
          status
        FROM affiliates
        WHERE affiliate_code = ?
          AND status = 'ACTIVE'
        LIMIT 1
      `,
      [code],
    );

    if (!row) return null;

    return {
      id: Number(row.id),
      user_id: Number(row.user_id || 0) || null,
      affiliate_code: normalizeAffiliateCode(row.affiliate_code),
      referral_slug: row.referral_slug || null,
      commission_rate: Number(row.commission_rate || 0),
      status: row.status || "INACTIVE",
    };
  } catch {
    return null;
  }
}

async function buildAffiliateOrderMeta(conn, affiliateCode, baseAmount) {
  const affiliate = await findActiveAffiliateByCode(conn, affiliateCode);
  const orderCols = await detectAffiliateOrderCols(conn);

  if (!affiliate) {
    return {
      affiliate: null,
      orderCols,
      orderMeta: {
        affiliate_id: null,
        affiliate_code: null,
        affiliate_commission_rate: 0,
        affiliate_commission_amount: 0,
      },
    };
  }

  const rate = Number(affiliate.commission_rate || 0);
  const amount = computeAffiliateCommission(baseAmount, rate);

  return {
    affiliate,
    orderCols,
    orderMeta: {
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.affiliate_code,
      affiliate_commission_rate: rate,
      affiliate_commission_amount: amount,
    },
  };
}

function pushAffiliateOrderColumns(
  cols,
  placeholders,
  vals,
  orderCols,
  orderMeta,
) {
  if (orderCols.affiliate_id) {
    cols.push("affiliate_id");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_id);
  }

  if (orderCols.affiliate_code) {
    cols.push("affiliate_code");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_code);
  }

  if (orderCols.affiliate_commission_rate) {
    cols.push("affiliate_commission_rate");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_commission_rate || 0);
  }

  if (orderCols.affiliate_commission_amount) {
    cols.push("affiliate_commission_amount");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_commission_amount || 0);
  }
}

async function commissionExistsForOrder(conn, affiliateId, orderId, orderItemId = null) {
  const cleanOrderItemId = normalizeOrderItemId(orderItemId);

  if (cleanOrderItemId) {
    const [[row]] = await conn.query(
      `
        SELECT id
        FROM affiliate_commissions
        WHERE affiliate_id = ?
          AND order_id = ?
          AND order_item_id = ?
        LIMIT 1
      `,
      [affiliateId, orderId, cleanOrderItemId],
    );
    return !!row;
  }

  const [[row]] = await conn.query(
    `
      SELECT id
      FROM affiliate_commissions
      WHERE affiliate_id = ?
        AND order_id = ?
      LIMIT 1
    `,
    [affiliateId, orderId],
  );
  return !!row;
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
  {
    affiliateId = null,
    periodType,
    periodKey,
    periodStart,
    periodEnd,
  },
) {
  const reportCols = await detectAffiliateRevenueReportCols(conn);
  if (!reportCols.period_type || !reportCols.period_key) return;

  const [[clickRow]] = await conn.query(
    `
      SELECT COUNT(*) AS clicks_count
      FROM affiliate_clicks
      WHERE (? IS NULL OR affiliate_id = ?)
        AND DATE(created_at) BETWEEN ? AND ?
    `,
    [affiliateId, affiliateId, periodStart, periodEnd],
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
      WHERE (? IS NULL OR affiliate_id = ?)
        AND period_day BETWEEN ? AND ?
    `,
    [affiliateId, affiliateId, periodStart, periodEnd],
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
      affiliateId,
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

async function rebuildAffiliateReports(conn, affiliateId = null, baseDate = new Date()) {
  const day = periodMeta("DAY", baseDate);
  const week = periodMeta("WEEK", baseDate);
  const month = periodMeta("MONTH", baseDate);
  const year = periodMeta("YEAR", baseDate);

  await upsertAffiliateRevenueReport(conn, {
    affiliateId,
    periodType: "DAY",
    periodKey: day.period_key,
    periodStart: day.period_start,
    periodEnd: day.period_end,
  });

  await upsertAffiliateRevenueReport(conn, {
    affiliateId,
    periodType: "WEEK",
    periodKey: week.period_key,
    periodStart: week.period_start,
    periodEnd: week.period_end,
  });

  await upsertAffiliateRevenueReport(conn, {
    affiliateId,
    periodType: "MONTH",
    periodKey: month.period_key,
    periodStart: month.period_start,
    periodEnd: month.period_end,
  });

  await upsertAffiliateRevenueReport(conn, {
    affiliateId,
    periodType: "YEAR",
    periodKey: year.period_key,
    periodStart: year.period_start,
    periodEnd: year.period_end,
  });
}

async function finalizeAffiliateOrder(
  conn,
  {
    affiliate,
    orderId,
    displayCode,
    baseAmount,
    orderMeta,
    productId = null,
    orderItemId = null,
    source = null,
    createdAt = null,
  },
) {
  if (!affiliate || !orderId) return null;

  const commissionAmount = Number(orderMeta?.affiliate_commission_amount || 0);
  if (!Number.isFinite(commissionAmount) || commissionAmount <= 0) return null;

  const cleanProductId = normalizeProductId(productId);
  const cleanOrderItemId = normalizeOrderItemId(orderItemId);
  const baseDate = createdAt || new Date();
  const periods = getCommissionPeriodMeta(baseDate);

  const alreadyExists = await commissionExistsForOrder(
    conn,
    affiliate.id,
    orderId,
    cleanOrderItemId,
  );

  if (alreadyExists) {
    await syncAffiliateCounters(conn, affiliate.id);
    await rebuildAffiliateReports(conn, affiliate.id, baseDate);
    await rebuildAffiliateReports(conn, null, baseDate);
    return null;
  }

  const commissionCols = await detectAffiliateCommissionCols(conn);

  const cols = [];
  const vals = [];
  const qs = [];

  if (commissionCols.affiliate_id) {
    cols.push("affiliate_id");
    vals.push(affiliate.id);
    qs.push("?");
  }

  if (commissionCols.order_id) {
    cols.push("order_id");
    vals.push(orderId);
    qs.push("?");
  }

  if (commissionCols.order_item_id) {
    cols.push("order_item_id");
    vals.push(cleanOrderItemId);
    qs.push("?");
  }

  if (commissionCols.affiliate_code) {
    cols.push("affiliate_code");
    vals.push(affiliate.affiliate_code);
    qs.push("?");
  }

  if (commissionCols.amount) {
    cols.push("amount");
    vals.push(commissionAmount);
    qs.push("?");
  }

  if (commissionCols.commission_rate) {
    cols.push("commission_rate");
    vals.push(Number(orderMeta?.affiliate_commission_rate || 0));
    qs.push("?");
  }

  if (commissionCols.base_amount) {
    cols.push("base_amount");
    vals.push(Number(baseAmount || 0));
    qs.push("?");
  }

  if (commissionCols.product_id) {
    cols.push("product_id");
    vals.push(cleanProductId);
    qs.push("?");
  }

  if (commissionCols.currency) {
    cols.push("currency");
    vals.push("MAD");
    qs.push("?");
  }

  if (commissionCols.status) {
    cols.push("status");
    vals.push("PENDING");
    qs.push("?");
  }

  if (commissionCols.period_day) {
    cols.push("period_day");
    vals.push(periods.period_day);
    qs.push("?");
  }

  if (commissionCols.period_week_start) {
    cols.push("period_week_start");
    vals.push(periods.period_week_start);
    qs.push("?");
  }

  if (commissionCols.period_month) {
    cols.push("period_month");
    vals.push(periods.period_month);
    qs.push("?");
  }

  if (commissionCols.period_year) {
    cols.push("period_year");
    vals.push(periods.period_year);
    qs.push("?");
  }

  if (commissionCols.source) {
    cols.push("source");
    vals.push(source || null);
    qs.push("?");
  }

  if (commissionCols.note) {
    cols.push("note");
    vals.push(
      cleanProductId
        ? `Commission affilié sur commande ${displayCode} - produit ${cleanProductId}`
        : `Commission affilié sur commande ${displayCode}`,
    );
    qs.push("?");
  }

  if (commissionCols.created_at) {
    cols.push("created_at");
    if (createdAt) {
      vals.push(new Date(createdAt));
      qs.push("?");
    } else {
      qs.push("NOW()");
    }
  }

  if (commissionCols.updated_at) {
    cols.push("updated_at");
    if (createdAt) {
      vals.push(new Date(createdAt));
      qs.push("?");
    } else {
      qs.push("NOW()");
    }
  }

  if (cols.length) {
    await conn.query(
      `INSERT INTO affiliate_commissions (${cols.join(", ")}) VALUES (${qs.join(", ")})`,
      vals,
    );
  }

  await syncAffiliateCounters(conn, affiliate.id);
  await rebuildAffiliateReports(conn, affiliate.id, baseDate);
  await rebuildAffiliateReports(conn, null, baseDate);

  return {
    affiliate_id: affiliate.id,
    order_id: orderId,
    amount: commissionAmount,
    commission_rate: Number(orderMeta?.affiliate_commission_rate || 0),
    base_amount: Number(baseAmount || 0),
    period_day: periods.period_day,
    period_week_start: periods.period_week_start,
    period_month: periods.period_month,
    period_year: periods.period_year,
  };
}

async function attachAffiliateToExistingOrder(
  conn,
  {
    orderId,
    affiliateCode,
    baseAmount,
    productId = null,
    orderItemId = null,
    source = null,
    displayCode = null,
    createdAt = null,
  },
) {
  const cleanOrderId = Number(orderId);
  if (!Number.isFinite(cleanOrderId) || cleanOrderId <= 0) {
    return {
      affiliate: null,
      orderMeta: null,
      commission: null,
    };
  }

  const { affiliate, orderCols, orderMeta } = await buildAffiliateOrderMeta(
    conn,
    affiliateCode,
    baseAmount,
  );

  if (!affiliate) {
    return {
      affiliate: null,
      orderMeta,
      commission: null,
    };
  }

  const sets = [];
  const vals = [];

  if (orderCols.affiliate_id) {
    sets.push("affiliate_id = ?");
    vals.push(orderMeta.affiliate_id);
  }

  if (orderCols.affiliate_code) {
    sets.push("affiliate_code = ?");
    vals.push(orderMeta.affiliate_code);
  }

  if (orderCols.affiliate_commission_rate) {
    sets.push("affiliate_commission_rate = ?");
    vals.push(orderMeta.affiliate_commission_rate || 0);
  }

  if (orderCols.affiliate_commission_amount) {
    sets.push("affiliate_commission_amount = ?");
    vals.push(orderMeta.affiliate_commission_amount || 0);
  }

  if (sets.length) {
    await conn.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE id = ?`,
      [...vals, cleanOrderId],
    );
  }

  const commission = await finalizeAffiliateOrder(conn, {
    affiliate,
    orderId: cleanOrderId,
    displayCode: displayCode || `#${cleanOrderId}`,
    baseAmount,
    orderMeta,
    productId,
    orderItemId,
    source,
    createdAt,
  });

  return {
    affiliate,
    orderMeta,
    commission,
  };
}

module.exports = {
  COMMISSION_STATUSES,
  normalizeAffiliateCode,
  normalizeProductId,
  normalizeOrderItemId,
  computeAffiliateCommission,
  toDateOnly,
  periodMeta,
  getCommissionPeriodMeta,
  findActiveAffiliateByCode,
  buildAffiliateOrderMeta,
  pushAffiliateOrderColumns,
  commissionExistsForOrder,
  syncAffiliateCounters,
  upsertAffiliateRevenueReport,
  rebuildAffiliateReports,
  finalizeAffiliateOrder,
  attachAffiliateToExistingOrder,
};