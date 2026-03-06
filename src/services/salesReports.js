const { getPool } = require("../lib/db");

const PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateTimeSql(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ${pad2(
    x.getHours()
  )}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return endOfDay(e);
}

function startOfMonth(d) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function endOfMonth(d) {
  const x = startOfMonth(d);
  x.setMonth(x.getMonth() + 1);
  x.setDate(0);
  return endOfDay(x);
}

function startOfYear(d) {
  const x = startOfDay(d);
  x.setMonth(0, 1);
  return x;
}

function endOfYear(d) {
  const x = startOfYear(d);
  x.setFullYear(x.getFullYear() + 1);
  x.setDate(0);
  return endOfDay(x);
}

function getRangeForPeriod(type, anchorDate) {
  const d = new Date(anchorDate);

  if (type === "DAILY") {
    return { start: startOfDay(d), end: endOfDay(d) };
  }

  if (type === "WEEKLY") {
    return { start: startOfWeek(d), end: endOfWeek(d) };
  }

  if (type === "MONTHLY") {
    return { start: startOfMonth(d), end: endOfMonth(d) };
  }

  if (type === "YEARLY") {
    return { start: startOfYear(d), end: endOfYear(d) };
  }

  throw new Error("Invalid period_type");
}

function getIncludedStatuses() {
  return ["DONE"];
}

function normalizeMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}

async function detectOrderColumns(conn) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM orders`);

  const names = new Set((cols || []).map((c) => String(c.Field || "").toLowerCase()));

  return {
    hasTotal: names.has("total"),
    hasTotalAmount: names.has("total_amount"),
    hasCommissionDuumini: names.has("commission_duumini"),
    hasDuuminiCommission: names.has("duumini_commission"),
    hasAmountPaid: names.has("amount_paid"),
    hasPaidAmount: names.has("paid_amount"),
    hasCurrency: names.has("currency"),
    hasPaymentStatus: names.has("payment_status"),
    hasCreatedAt: names.has("created_at"),
    hasUpdatedAt: names.has("updated_at"),
  };
}

function pickOrderColumns(meta) {
  const totalExpr = meta.hasTotalAmount
    ? "o.total_amount"
    : meta.hasTotal
      ? "o.total"
      : "0";

  const commissionExpr = meta.hasDuuminiCommission
    ? "o.duumini_commission"
    : meta.hasCommissionDuumini
      ? "o.commission_duumini"
      : "0";

  const amountPaidExpr = meta.hasAmountPaid
    ? "o.amount_paid"
    : meta.hasPaidAmount
      ? "o.paid_amount"
      : "0";

  const paymentStatusExpr = meta.hasPaymentStatus
    ? "COALESCE(o.payment_status,'UNKNOWN')"
    : "'UNKNOWN'";

  const dateExpr = meta.hasCreatedAt
    ? "o.created_at"
    : meta.hasUpdatedAt
      ? "o.updated_at"
      : "o.created_at";

  return {
    totalExpr,
    commissionExpr,
    amountPaidExpr,
    paymentStatusExpr,
    dateExpr,
  };
}

async function computeSalesMetrics(conn, { start, end, currency = "MAD" }) {
  const statuses = getIncludedStatuses();
  const meta = await detectOrderColumns(conn);
  const { totalExpr, commissionExpr, amountPaidExpr, paymentStatusExpr, dateExpr } =
    pickOrderColumns(meta);

  const where = [];
  const params = [];

  where.push(`o.status IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (meta.hasCurrency) {
    where.push(`o.currency = ?`);
    params.push(currency);
  }

  where.push(`${dateExpr} >= ?`);
  where.push(`${dateExpr} <= ?`);
  params.push(toDateTimeSql(start), toDateTimeSql(end));

  const whereSql = where.join(" AND ");

  const [[row]] = await conn.query(
    `
    SELECT
      COUNT(DISTINCT o.id) AS orders_count,
      COALESCE(SUM(oi.qty * oi.unit_price), 0) AS items_amount,
      COALESCE(SUM(DISTINCT ${totalExpr}), 0) AS total_amount,
      COALESCE(SUM(DISTINCT ${commissionExpr}), 0) AS duumini_commission,
      COALESCE(SUM(DISTINCT ${amountPaidExpr}), 0) AS paid_amount
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE ${whereSql}
    `,
    params
  );

  const ordersCount = Number(row?.orders_count || 0);
  const itemsAmount = normalizeMoney(row?.items_amount);
  const totalAmount = normalizeMoney(row?.total_amount);
  const paidAmount = normalizeMoney(row?.paid_amount);
  const deliveryAmount = normalizeMoney(Math.max(0, totalAmount - itemsAmount));
  const duuminiCommission = normalizeMoney(row?.duumini_commission);
  const remainingAmount = normalizeMoney(Math.max(0, totalAmount - paidAmount));

  let paymentBreakdown = [];
  try {
    const [payRows] = await conn.query(
      `
      SELECT
        ${paymentStatusExpr} AS payment_status,
        COUNT(*) AS cnt,
        COALESCE(SUM(${totalExpr}), 0) AS amount
      FROM orders o
      WHERE ${whereSql}
      GROUP BY ${paymentStatusExpr}
      ORDER BY cnt DESC
      `,
      params
    );

    paymentBreakdown = (payRows || []).map((r) => ({
      payment_status: r.payment_status || "UNKNOWN",
      cnt: Number(r.cnt || 0),
      amount: normalizeMoney(r.amount),
    }));
  } catch {
    paymentBreakdown = [];
  }

  return {
    orders_count: ordersCount,
    items_amount: itemsAmount,
    delivery_amount: deliveryAmount,
    total_amount: totalAmount,
    duumini_commission: duuminiCommission,
    details_json: {
      paid_amount: paidAmount,
      remaining_amount: remainingAmount,
      payment_breakdown: paymentBreakdown,
    },
  };
}

async function upsertReport({ period_type, anchorDate, currency = "MAD" }) {
  if (!PERIODS.includes(period_type)) throw new Error("Invalid period_type");

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const { start, end } = getRangeForPeriod(period_type, anchorDate);
    const period_start = toDateTimeSql(start);
    const period_end = toDateTimeSql(end);

    const metrics = await computeSalesMetrics(conn, { start, end, currency });

    await conn.query(
      `
      INSERT INTO sales_reports
      (
        period_type,
        period_start,
        period_end,
        currency,
        orders_count,
        items_amount,
        delivery_amount,
        total_amount,
        duumini_commission,
        details_json
      )
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        orders_count = VALUES(orders_count),
        items_amount = VALUES(items_amount),
        delivery_amount = VALUES(delivery_amount),
        total_amount = VALUES(total_amount),
        duumini_commission = VALUES(duumini_commission),
        details_json = VALUES(details_json),
        updated_at = NOW()
      `,
      [
        period_type,
        period_start,
        period_end,
        currency,
        metrics.orders_count,
        metrics.items_amount,
        metrics.delivery_amount,
        metrics.total_amount,
        metrics.duumini_commission,
        metrics.details_json ? JSON.stringify(metrics.details_json) : null,
      ]
    );

    const [[saved]] = await conn.query(
      `
      SELECT *
      FROM sales_reports
      WHERE period_type = ?
        AND currency = ?
        AND period_start = ?
        AND period_end = ?
      LIMIT 1
      `,
      [period_type, currency, period_start, period_end]
    );

    await conn.commit();

    return saved || {
      period_type,
      period_start,
      period_end,
      currency,
      ...metrics,
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

function stepDate(period_type, d) {
  const x = new Date(d);

  if (period_type === "DAILY") {
    x.setDate(x.getDate() + 1);
    return x;
  }

  if (period_type === "WEEKLY") {
    x.setDate(x.getDate() + 7);
    return x;
  }

  if (period_type === "MONTHLY") {
    x.setMonth(x.getMonth() + 1, 1);
    return x;
  }

  if (period_type === "YEARLY") {
    x.setFullYear(x.getFullYear() + 1, 0, 1);
    return x;
  }

  throw new Error("Invalid period_type");
}

function normalizeAnchor(period_type, d) {
  if (period_type === "DAILY") return startOfDay(d);
  if (period_type === "WEEKLY") return startOfWeek(d);
  if (period_type === "MONTHLY") return startOfMonth(d);
  if (period_type === "YEARLY") return startOfYear(d);
  throw new Error("Invalid period_type");
}

async function findFirstOrderDate(conn, currency = "MAD") {
  const meta = await detectOrderColumns(conn);
  const { dateExpr } = pickOrderColumns(meta);
  const statuses = getIncludedStatuses();

  const where = [];
  const params = [];

  where.push(`status IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (meta.hasCurrency) {
    where.push(`currency = ?`);
    params.push(currency);
  }

  const [[row]] = await conn.query(
    `
    SELECT MIN(${dateExpr}) AS first_date
    FROM orders
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return row?.first_date ? new Date(row.first_date) : null;
}

async function backfillSalesReports({
  period_type,
  currency = "MAD",
  fromDate = null,
  toDate = new Date(),
  onProgress = null,
}) {
  if (!PERIODS.includes(period_type)) throw new Error("Invalid period_type");

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    let startDate = fromDate ? new Date(fromDate) : await findFirstOrderDate(conn, currency);

    if (!startDate) {
      return {
        ok: true,
        period_type,
        currency,
        generated: 0,
        skipped: true,
        message: "Aucune commande DONE trouvée.",
      };
    }

    const endDate = new Date(toDate);
    let cursor = normalizeAnchor(period_type, startDate);
    const limit = normalizeAnchor(period_type, endDate);

    let generated = 0;

    while (cursor <= limit) {
      const out = await upsertReport({
        period_type,
        anchorDate: new Date(cursor),
        currency,
      });

      generated += 1;

      if (typeof onProgress === "function") {
        onProgress({
          generated,
          current_anchor: new Date(cursor),
          report: out,
        });
      }

      cursor = stepDate(period_type, cursor);
    }

    return {
      ok: true,
      period_type,
      currency,
      generated,
      from: toDateTimeSql(startDate),
      to: toDateTimeSql(endDate),
    };
  } finally {
    conn.release();
  }
}

module.exports = {
  PERIODS,
  upsertReport,
  getRangeForPeriod,
  backfillSalesReports,
  findFirstOrderDate,
};