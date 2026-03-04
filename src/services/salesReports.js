// src/services/salesReports.js
const { getPool } = require("../lib/db");

const PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Date -> "YYYY-MM-DD" en timezone serveur (Render = UTC souvent)
// Si tu veux stricte Africa/Abidjan, on peut forcer via cron tz + dates “UTC”
function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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

// week: Lundi -> Dimanche (ISO-ish)
function startOfWeek(d) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Mon=0 ... Sun=6
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
  x.setDate(0); // dernier jour mois précédent
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

// IMPORTANT : ici on compte les ventes “finalisées”
function getIncludedStatuses() {
  return ["DONE"]; // ✅ POS / ventes finalisées
}

async function computeSalesMetrics(conn, { start, end, currency = "MAD" }) {
  const statuses = getIncludedStatuses();

  // items_amount = somme (qty * unit_price) sur order_items
  // total_amount = orders.total (inclut livraison)
  // delivery = total - items
  const [[row]] = await conn.query(
    `
    SELECT
      COUNT(DISTINCT o.id) AS orders_count,
      COALESCE(SUM(oi.qty * oi.unit_price),0) AS items_amount,
      COALESCE(SUM(o.total),0) AS total_amount,
      COALESCE(SUM(o.commission_duumini),0) AS duumini_commission
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.currency = ?
      AND o.status IN (${statuses.map(() => "?").join(",")})
      AND o.created_at >= ? AND o.created_at <= ?
    `,
    [currency, ...statuses, start, end]
  );

  const ordersCount = Number(row?.orders_count || 0);
  const itemsAmount = Number(row?.items_amount || 0);
  const totalAmount = Number(row?.total_amount || 0);
  const deliveryAmount = Math.max(0, totalAmount - itemsAmount);
  const duuminiCommission = Number(row?.duumini_commission || 0);

  // Optionnel : breakdown paiement (si colonnes existent)
  let paymentBreakdown = null;
  try {
    const [payRows] = await conn.query(
      `
      SELECT
        COALESCE(payment_status,'UNKNOWN') AS payment_status,
        COUNT(*) AS cnt,
        COALESCE(SUM(total),0) AS amount
      FROM orders
      WHERE currency = ?
        AND status IN (${statuses.map(() => "?").join(",")})
        AND created_at >= ? AND created_at <= ?
      GROUP BY COALESCE(payment_status,'UNKNOWN')
      `,
      [currency, ...statuses, start, end]
    );
    paymentBreakdown = payRows || [];
  } catch {
    paymentBreakdown = null;
  }

  return {
    orders_count: ordersCount,
    items_amount: +itemsAmount.toFixed(2),
    delivery_amount: +deliveryAmount.toFixed(2),
    total_amount: +totalAmount.toFixed(2),
    duumini_commission: +duuminiCommission.toFixed(2),
    details_json: {
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
    const period_start = toDateStr(start);
    const period_end = toDateStr(end);

    const metrics = await computeSalesMetrics(conn, { start, end, currency });

    await conn.query(
      `
      INSERT INTO sales_reports
      (period_type, period_start, period_end, currency,
       orders_count, items_amount, delivery_amount, total_amount, duumini_commission, details_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        orders_count=VALUES(orders_count),
        items_amount=VALUES(items_amount),
        delivery_amount=VALUES(delivery_amount),
        total_amount=VALUES(total_amount),
        duumini_commission=VALUES(duumini_commission),
        details_json=VALUES(details_json),
        updated_at=NOW()
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

    await conn.commit();

    return {
      period_type,
      period_start,
      period_end,
      currency,
      ...metrics,
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  upsertReport,
  getRangeForPeriod,
};