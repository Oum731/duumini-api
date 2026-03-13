const { getPool } = require("../lib/db");

const PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateTimeSql(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(
    x.getDate()
  )} ${pad2(x.getHours())}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())}`;
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

function normMoney(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return 0;
  return +n.toFixed(2);
}

function safeJsonParse(v) {
  if (!v) return null;
  if (typeof v === "object") return v;

  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function normPayStatus(s) {
  const v = String(s || "").trim().toUpperCase();

  if (
    v === "PAID" ||
    v === "UNPAID" ||
    v === "PARTIAL" ||
    v === "PENDING"
  ) {
    return v;
  }

  return "UNKNOWN";
}

function getIncludedStatuses() {
  return ["DONE"];
}

/* =========================
 * Detect cols like orders.js
 * ======================= */
let _ordersReportCols = null;
let _ordersReportColsLoaded = false;

async function detectOrdersReportCols(conn) {
  const candidates = [
    "id",
    "status",
    "order_status",
    "currency",
    "created_at",
    "updated_at",
    "ordered_at",
    "order_date",
    "done_at",
    "completed_at",
    "total",
    "total_amount",
    "commission_duumini",
    "duumini_commission",
    "payment",
    "payment_status",
    "paid_amount",
    "remaining_amount",
  ];

  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    id: found.has("id"),
    status: found.has("status"),
    order_status: found.has("order_status"),
    currency: found.has("currency"),
    created_at: found.has("created_at"),
    updated_at: found.has("updated_at"),
    ordered_at: found.has("ordered_at"),
    order_date: found.has("order_date"),
    done_at: found.has("done_at"),
    completed_at: found.has("completed_at"),
    total: found.has("total"),
    total_amount: found.has("total_amount"),
    commission_duumini: found.has("commission_duumini"),
    duumini_commission: found.has("duumini_commission"),
    payment: found.has("payment"),
    payment_status: found.has("payment_status"),
    paid_amount: found.has("paid_amount"),
    remaining_amount: found.has("remaining_amount"),
  };
}

async function getOrdersReportColsCached(pool) {
  if (_ordersReportColsLoaded) return _ordersReportCols;

  const conn = await pool.getConnection();

  try {
    _ordersReportCols = await detectOrdersReportCols(conn);
    _ordersReportColsLoaded = true;
    return _ordersReportCols;
  } finally {
    conn.release();
  }
}

function pickStatusColumn(cols) {
  if (cols.status) return "status";
  if (cols.order_status) return "order_status";
  return null;
}

function pickDateColumn(cols) {
  if (cols.done_at) return "done_at";
  if (cols.completed_at) return "completed_at";
  if (cols.created_at) return "created_at";
  if (cols.ordered_at) return "ordered_at";
  if (cols.order_date) return "order_date";
  if (cols.updated_at) return "updated_at";
  return null;
}

function pickTotalColumn(cols) {
  if (cols.total) return "total";
  if (cols.total_amount) return "total_amount";
  return null;
}

function pickCommissionColumn(cols) {
  if (cols.commission_duumini) return "commission_duumini";
  if (cols.duumini_commission) return "duumini_commission";
  return null;
}

function buildPaymentFromRow(row, cols, totalAmount, currency) {
  const total = normMoney(totalAmount);
  const paymentParsed = cols.payment ? safeJsonParse(row?.payment) : null;

  const colStatus = cols.payment_status
    ? normPayStatus(row?.payment_status)
    : null;

  const colPaid = cols.paid_amount ? normMoney(row?.paid_amount) : null;
  const colRemain = cols.remaining_amount
    ? normMoney(row?.remaining_amount)
    : null;

  const jsonPaid = paymentParsed
    ? normMoney(paymentParsed.paid_amount ?? paymentParsed.paidAmount ?? 0)
    : 0;

  const paid = colPaid != null ? colPaid : jsonPaid;
  const remaining =
    colRemain != null
      ? colRemain
      : Math.max(0, total - Math.min(paid, total));

  let status = colStatus;

  if (!status || status === "UNKNOWN") {
    if (paid <= 0) status = "UNPAID";
    else if (paid >= total || total <= 0) status = "PAID";
    else status = "PARTIAL";
  }

  return {
    status,
    paid_amount: Math.min(paid, total),
    remaining_amount: remaining,
    currency: String(currency || "MAD").toUpperCase(),
  };
}

/* =========================
 * Core compute
 * ======================= */
async function computeSalesMetrics(conn, { start, end, currency = "MAD" }) {
  const pool = getPool();
  const cols = await getOrdersReportColsCached(pool);

  const statusCol = pickStatusColumn(cols);
  const dateCol = pickDateColumn(cols);
  const totalCol = pickTotalColumn(cols);
  const commissionCol = pickCommissionColumn(cols);

  if (!statusCol) {
    throw new Error(
      "Impossible de générer le rapport: aucune colonne status/order_status trouvée dans orders."
    );
  }

  if (!dateCol) {
    throw new Error(
      "Impossible de générer le rapport: aucune colonne de date exploitable trouvée dans orders."
    );
  }

  if (!totalCol) {
    throw new Error(
      "Impossible de générer le rapport: aucune colonne total/total_amount trouvée dans orders."
    );
  }

  const statuses = getIncludedStatuses();
  const where = [];
  const params = [];

  where.push(`o.${statusCol} IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (cols.currency) {
    where.push(`o.currency = ?`);
    params.push(currency);
  }

  where.push(`o.${dateCol} >= ?`);
  where.push(`o.${dateCol} <= ?`);
  params.push(toDateTimeSql(start), toDateTimeSql(end));

  const whereSql = where.join(" AND ");

  const [orderRows] = await conn.query(
    `
    SELECT
      o.id,
      o.${totalCol} AS total_amount,
      ${commissionCol ? `o.${commissionCol}` : "0"} AS duumini_commission
      ${cols.payment ? ", o.payment" : ""}
      ${cols.payment_status ? ", o.payment_status" : ""}
      ${cols.paid_amount ? ", o.paid_amount" : ""}
      ${cols.remaining_amount ? ", o.remaining_amount" : ""}
      ${cols.currency ? ", o.currency" : ""}
    FROM orders o
    WHERE ${whereSql}
    ORDER BY o.id ASC
    `,
    params
  );

  const orderIds = (orderRows || []).map((r) => Number(r.id)).filter(Boolean);

  let itemsAmount = 0;

  if (orderIds.length) {
    const [itemRows] = await conn.query(
      `
      SELECT
        oi.order_id,
        COALESCE(SUM(oi.qty * oi.unit_price), 0) AS items_total
      FROM order_items oi
      WHERE oi.order_id IN (${orderIds.map(() => "?").join(",")})
      GROUP BY oi.order_id
      `,
      orderIds
    );

    const itemsMap = new Map(
      (itemRows || []).map((r) => [
        Number(r.order_id),
        normMoney(r.items_total),
      ])
    );

    itemsAmount = orderRows.reduce((sum, r) => {
      return sum + normMoney(itemsMap.get(Number(r.id)) || 0);
    }, 0);
  }

  const ordersCount = Number(orderRows?.length || 0);

  const totalAmount = orderRows.reduce((sum, r) => {
    return sum + normMoney(r.total_amount);
  }, 0);

  const duuminiCommission = orderRows.reduce((sum, r) => {
    return sum + normMoney(r.duumini_commission);
  }, 0);

  const paymentBreakdownMap = new Map();
  let paidAmount = 0;
  let remainingAmount = 0;

  for (const row of orderRows) {
    const payment = buildPaymentFromRow(
      row,
      cols,
      Number(row.total_amount || 0),
      cols.currency ? row.currency || currency : currency
    );

    paidAmount += normMoney(payment.paid_amount);
    remainingAmount += normMoney(payment.remaining_amount);

    const key = payment.status || "UNKNOWN";
    const prev = paymentBreakdownMap.get(key) || {
      payment_status: key,
      cnt: 0,
      amount: 0,
    };

    prev.cnt += 1;
    prev.amount += normMoney(row.total_amount);

    paymentBreakdownMap.set(key, prev);
  }

  const paymentBreakdown = Array.from(paymentBreakdownMap.values()).map(
    (x) => ({
      payment_status: x.payment_status,
      cnt: Number(x.cnt || 0),
      amount: normMoney(x.amount),
    })
  );

  const deliveryAmount = Math.max(0, normMoney(totalAmount - itemsAmount));

  return {
    orders_count: ordersCount,
    items_amount: normMoney(itemsAmount),
    delivery_amount: normMoney(deliveryAmount),
    total_amount: normMoney(totalAmount),
    duumini_commission: normMoney(duuminiCommission),
    details_json: {
      paid_amount: normMoney(paidAmount),
      remaining_amount: normMoney(remainingAmount),
      payment_breakdown: paymentBreakdown,
      included_statuses: statuses,
      date_column_used: dateCol,
    },
  };
}

/* =========================
 * Single upsert
 * ======================= */
async function upsertReport({ period_type, anchorDate, currency = "MAD" }) {
  if (!PERIODS.includes(period_type)) {
    throw new Error("Invalid period_type");
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const { start, end } = getRangeForPeriod(period_type, anchorDate);
    const period_start = toDateTimeSql(start);
    const period_end = toDateTimeSql(end);

    const metrics = await computeSalesMetrics(conn, {
      start,
      end,
      currency,
    });

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

    return (
      saved || {
        period_type,
        period_start,
        period_end,
        currency,
        ...metrics,
      }
    );
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    throw e;
  } finally {
    conn.release();
  }
}

/* =========================
 * Find first order date
 * ======================= */
async function findFirstOrderDate(conn, currency = "MAD") {
  const pool = getPool();
  const cols = await getOrdersReportColsCached(pool);

  const statusCol = pickStatusColumn(cols);
  const dateCol = pickDateColumn(cols);

  if (!statusCol || !dateCol) return null;

  const statuses = getIncludedStatuses();
  const where = [];
  const params = [];

  where.push(`${statusCol} IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (cols.currency) {
    where.push(`currency = ?`);
    params.push(currency);
  }

  const [[row]] = await conn.query(
    `
    SELECT MIN(${dateCol}) AS first_date
    FROM orders
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return row?.first_date ? new Date(row.first_date) : null;
}

/* =========================
 * Backfill
 * ======================= */
async function backfillSalesReports({
  period_type,
  currency = "MAD",
  fromDate = null,
  toDate = new Date(),
  onProgress = null,
}) {
  if (!PERIODS.includes(period_type)) {
    throw new Error("Invalid period_type");
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    let startDate = fromDate
      ? new Date(fromDate)
      : await findFirstOrderDate(conn, currency);

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