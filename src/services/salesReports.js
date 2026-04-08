const { getPool } = require("../lib/db");

const PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const DUUMINI_COMMISSION_RATE = 0.09;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateSql(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
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

  if (type === "DAILY") return { start: startOfDay(d), end: endOfDay(d) };
  if (type === "WEEKLY") return { start: startOfWeek(d), end: endOfWeek(d) };
  if (type === "MONTHLY") return { start: startOfMonth(d), end: endOfMonth(d) };
  if (type === "YEARLY") return { start: startOfYear(d), end: endOfYear(d) };

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
  if (!Number.isFinite(n)) return 0;
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

  if (v === "PAID" || v === "UNPAID" || v === "PARTIAL" || v === "PENDING") {
    return v;
  }

  return "UNKNOWN";
}

function getIncludedStatuses() {
  return ["DONE"];
}

function computeDuuminiCommission(itemsAmount) {
  const base = Number(itemsAmount || 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return normMoney(base * DUUMINI_COMMISSION_RATE);
}

let _ordersReportCols = null;
let _ordersReportColsLoaded = false;

let _orderItemsReportCols = null;
let _orderItemsReportColsLoaded = false;

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
    "delivery_fee",
    "shipping_fee",
    "delivery_amount",
    "items_subtotal",
    "admin_discount_amount",
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
    delivery_fee: found.has("delivery_fee"),
    shipping_fee: found.has("shipping_fee"),
    delivery_amount: found.has("delivery_amount"),
    items_subtotal: found.has("items_subtotal"),
    admin_discount_amount: found.has("admin_discount_amount"),
  };
}

async function detectOrderItemsReportCols(conn) {
  const candidates = [
    "order_id",
    "qty",
    "quantity",
    "unit_price",
    "price",
    "final_unit_price",
    "sale_unit_price",
    "purchase_price",
    "purchase_unit_price",
    "buy_price",
    "buying_price",
    "cost_price",
    "unit_cost_price",
    "unit_purchase_price",
    "snapshot_purchase_price",
    "product_purchase_price",
  ];

  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    order_id: found.has("order_id"),
    qty: found.has("qty"),
    quantity: found.has("quantity"),
    unit_price: found.has("unit_price"),
    price: found.has("price"),
    final_unit_price: found.has("final_unit_price"),
    sale_unit_price: found.has("sale_unit_price"),
    purchase_price: found.has("purchase_price"),
    purchase_unit_price: found.has("purchase_unit_price"),
    buy_price: found.has("buy_price"),
    buying_price: found.has("buying_price"),
    cost_price: found.has("cost_price"),
    unit_cost_price: found.has("unit_cost_price"),
    unit_purchase_price: found.has("unit_purchase_price"),
    snapshot_purchase_price: found.has("snapshot_purchase_price"),
    product_purchase_price: found.has("product_purchase_price"),
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

async function getOrderItemsReportColsCached(pool) {
  if (_orderItemsReportColsLoaded) return _orderItemsReportCols;

  const conn = await pool.getConnection();
  try {
    _orderItemsReportCols = await detectOrderItemsReportCols(conn);
    _orderItemsReportColsLoaded = true;
    return _orderItemsReportCols;
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
  if (cols.created_at) return "created_at";
  if (cols.ordered_at) return "ordered_at";
  if (cols.order_date) return "order_date";
  if (cols.done_at) return "done_at";
  if (cols.completed_at) return "completed_at";
  if (cols.updated_at) return "updated_at";
  return null;
}

function pickCommissionColumn(cols) {
  if (cols.commission_duumini) return "commission_duumini";
  if (cols.duumini_commission) return "duumini_commission";
  return null;
}

function pickDeliveryColumn(cols) {
  if (cols.delivery_fee) return "delivery_fee";
  if (cols.shipping_fee) return "shipping_fee";
  if (cols.delivery_amount) return "delivery_amount";
  return null;
}

function pickOrderItemsQtyColumn(cols) {
  if (cols.qty) return "qty";
  if (cols.quantity) return "quantity";
  return null;
}

function pickOrderItemsPurchasePriceColumn(cols) {
  if (cols.purchase_unit_price) return "purchase_unit_price";
  if (cols.unit_purchase_price) return "unit_purchase_price";
  if (cols.snapshot_purchase_price) return "snapshot_purchase_price";
  if (cols.purchase_price) return "purchase_price";
  if (cols.product_purchase_price) return "product_purchase_price";
  if (cols.unit_cost_price) return "unit_cost_price";
  if (cols.cost_price) return "cost_price";
  if (cols.buying_price) return "buying_price";
  if (cols.buy_price) return "buy_price";
  return null;
}

function pickOrderItemsFallbackSalePriceColumn(cols) {
  if (cols.final_unit_price) return "final_unit_price";
  if (cols.sale_unit_price) return "sale_unit_price";
  if (cols.unit_price) return "unit_price";
  if (cols.price) return "price";
  return null;
}

function extractPaidAmount(paymentParsed, colPaid) {
  if (Number.isFinite(Number(colPaid))) return normMoney(colPaid);
  if (!paymentParsed) return 0;

  const candidates = [
    paymentParsed.paid_amount,
    paymentParsed.paidAmount,
    paymentParsed.amount_paid,
    paymentParsed.total_paid,
    paymentParsed.sum_paid,
    paymentParsed.encaisse,
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return normMoney(n);
  }

  return 0;
}

function extractRemainingAmount(paymentParsed, colRemain, total, paid) {
  if (Number.isFinite(Number(colRemain))) return normMoney(colRemain);

  if (paymentParsed) {
    const candidates = [
      paymentParsed.remaining_amount,
      paymentParsed.remainingAmount,
      paymentParsed.remaining,
      paymentParsed.amount_remaining,
      paymentParsed.reste_a_payer,
      paymentParsed.rest_to_pay,
    ];

    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return normMoney(n);
    }
  }

  return normMoney(Math.max(0, total - paid));
}

function buildPaymentFromRow(row, cols, totalAmount, currency) {
  const total = normMoney(totalAmount);
  const paymentParsed = cols.payment ? safeJsonParse(row?.payment) : null;

  const colStatus = cols.payment_status
    ? normPayStatus(row?.payment_status)
    : null;

  const paid = Math.min(
    extractPaidAmount(paymentParsed, cols.paid_amount ? row?.paid_amount : null),
    total
  );

  let remaining = extractRemainingAmount(
    paymentParsed,
    cols.remaining_amount ? row?.remaining_amount : null,
    total,
    paid
  );

  if (!Number.isFinite(remaining)) remaining = Math.max(0, total - paid);
  remaining = normMoney(Math.max(0, Math.min(remaining, total)));

  let status = colStatus;

  if (!status || status === "UNKNOWN") {
    if (paid <= 0) status = "UNPAID";
    else if (paid >= total || total <= 0) status = "PAID";
    else status = "PARTIAL";
  }

  return {
    status,
    paid_amount: normMoney(paid),
    remaining_amount: remaining,
    currency: String(currency || "MAD").toUpperCase(),
  };
}

function computeRowAmounts(row, cols, itemsMap) {
  const rowId = Number(row.id);

  const mapValue = itemsMap.has(rowId) ? itemsMap.get(rowId) : null;

  const rowGrossItems =
    mapValue !== null && mapValue !== undefined
      ? normMoney(mapValue)
      : cols.items_subtotal
      ? normMoney(row.items_subtotal)
      : 0;

  const rowDiscount = cols.admin_discount_amount
    ? normMoney(row.admin_discount_amount)
    : 0;

  const rowNetItems = normMoney(Math.max(0, rowGrossItems - rowDiscount));

  const rowDelivery = pickDeliveryColumn(cols)
    ? normMoney(row.delivery_amount_exact)
    : 0;

  const rowTotal = normMoney(rowNetItems);

  return {
    gross_items_amount: rowGrossItems,
    admin_discount_amount: rowDiscount,
    net_items_amount: rowNetItems,
    delivery_amount: rowDelivery,
    total_amount: rowTotal,
  };
}

async function computeSalesMetrics(conn, { start, end, currency = "MAD" }) {
  const pool = getPool();
  const cols = await getOrdersReportColsCached(pool);
  const itemCols = await getOrderItemsReportColsCached(pool);

  const statusCol = pickStatusColumn(cols);
  const dateCol = pickDateColumn(cols);
  const commissionCol = pickCommissionColumn(cols);
  const deliveryCol = pickDeliveryColumn(cols);

  const itemQtyCol = pickOrderItemsQtyColumn(itemCols);
  const itemPurchasePriceCol = pickOrderItemsPurchasePriceColumn(itemCols);
  const itemFallbackSalePriceCol = pickOrderItemsFallbackSalePriceColumn(itemCols);
  const itemPriceCol = itemPurchasePriceCol || itemFallbackSalePriceCol;

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

  const statuses = getIncludedStatuses();
  const where = [];
  const params = [];

  where.push(`o.${statusCol} IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (cols.currency) {
    where.push(`UPPER(o.currency) = ?`);
    params.push(String(currency).toUpperCase());
  }

  where.push(`o.${dateCol} >= ?`);
  where.push(`o.${dateCol} <= ?`);
  params.push(toDateTimeSql(start), toDateTimeSql(end));

  const whereSql = where.join(" AND ");

  const [orderRows] = await conn.query(
    `
    SELECT
      o.id
      ${commissionCol ? `, o.${commissionCol} AS duumini_commission` : ", NULL AS duumini_commission"}
      ${deliveryCol ? `, o.${deliveryCol} AS delivery_amount_exact` : ", NULL AS delivery_amount_exact"}
      ${cols.items_subtotal ? `, o.items_subtotal` : ", NULL AS items_subtotal"}
      ${cols.admin_discount_amount ? `, o.admin_discount_amount` : ", NULL AS admin_discount_amount"}
      ${cols.payment ? ", o.payment" : ", NULL AS payment"}
      ${cols.payment_status ? ", o.payment_status" : ", NULL AS payment_status"}
      ${cols.paid_amount ? ", o.paid_amount" : ", NULL AS paid_amount"}
      ${cols.remaining_amount ? ", o.remaining_amount" : ", NULL AS remaining_amount"}
      ${cols.currency ? ", o.currency" : ", NULL AS currency"}
    FROM orders o
    WHERE ${whereSql}
    ORDER BY o.id ASC
    `,
    params
  );

  const ordersCount = Number(orderRows?.length || 0);

  if (!ordersCount) {
    return {
      orders_count: 0,
      items_amount: 0,
      delivery_amount: 0,
      total_amount: 0,
      duumini_commission: 0,
      details_json: {
        gross_items_amount: 0,
        admin_discount_amount: 0,
        net_items_amount: 0,
        paid_amount: 0,
        remaining_amount: 0,
        payment_breakdown: [],
        included_statuses: statuses,
        date_column_used: dateCol,
        delivery_column_used: deliveryCol || null,
        item_qty_column_used: itemQtyCol || null,
        item_price_column_used: itemPriceCol || null,
        item_price_mode: itemPurchasePriceCol
          ? "PURCHASE_PRICE_SNAPSHOT"
          : itemFallbackSalePriceCol
          ? "ORDER_ITEM_SALE_PRICE_FALLBACK"
          : "ORDER_SUMMARY_FALLBACK",
      },
    };
  }

  const orderIds = orderRows.map((r) => Number(r.id)).filter(Boolean);
  const itemsMap = new Map();

  if (orderIds.length && itemQtyCol && itemPriceCol) {
    const [itemRows] = await conn.query(
      `
      SELECT
        oi.order_id,
        COALESCE(SUM(COALESCE(oi.${itemQtyCol}, 0) * COALESCE(oi.${itemPriceCol}, 0)), 0) AS items_total
      FROM order_items oi
      WHERE oi.order_id IN (${orderIds.map(() => "?").join(",")})
      GROUP BY oi.order_id
      `,
      orderIds
    );

    for (const row of itemRows || []) {
      itemsMap.set(Number(row.order_id), normMoney(row.items_total));
    }
  }

  let grossItemsAmount = 0;
  let adminDiscountAmount = 0;
  let netItemsAmount = 0;
  let totalAmount = 0;
  let deliveryAmount = 0;
  let duuminiCommission = 0;
  let paidAmount = 0;
  let remainingAmount = 0;

  const paymentBreakdownMap = new Map();

  for (const row of orderRows) {
    const amounts = computeRowAmounts(row, cols, itemsMap);

    const rowCommissionRaw = Number(row.duumini_commission);
    const rowCommission = Number.isFinite(rowCommissionRaw)
      ? normMoney(rowCommissionRaw)
      : computeDuuminiCommission(amounts.net_items_amount);

    const payment = buildPaymentFromRow(
      row,
      cols,
      amounts.total_amount,
      cols.currency ? row.currency || currency : currency
    );

    grossItemsAmount += amounts.gross_items_amount;
    adminDiscountAmount += amounts.admin_discount_amount;
    netItemsAmount += amounts.net_items_amount;
    deliveryAmount += amounts.delivery_amount;
    totalAmount += amounts.net_items_amount;
    duuminiCommission += rowCommission;
    paidAmount += normMoney(payment.paid_amount);
    remainingAmount += normMoney(payment.remaining_amount);

    const key = payment.status || "UNKNOWN";
    const prev = paymentBreakdownMap.get(key) || {
      payment_status: key,
      cnt: 0,
      amount: 0,
      paid_amount: 0,
      remaining_amount: 0,
    };

    prev.cnt += 1;
    prev.amount += amounts.net_items_amount;
    prev.paid_amount += normMoney(payment.paid_amount);
    prev.remaining_amount += normMoney(payment.remaining_amount);

    paymentBreakdownMap.set(key, prev);
  }

  const paymentBreakdown = Array.from(paymentBreakdownMap.values()).map((x) => ({
    payment_status: x.payment_status,
    cnt: Number(x.cnt || 0),
    amount: normMoney(x.amount),
    paid_amount: normMoney(x.paid_amount),
    remaining_amount: normMoney(x.remaining_amount),
  }));

  return {
    orders_count: ordersCount,
    items_amount: normMoney(netItemsAmount),
    delivery_amount: normMoney(deliveryAmount),
    total_amount: normMoney(totalAmount),
    duumini_commission: normMoney(duuminiCommission),
    details_json: {
      gross_items_amount: normMoney(grossItemsAmount),
      admin_discount_amount: normMoney(adminDiscountAmount),
      net_items_amount: normMoney(netItemsAmount),
      paid_amount: normMoney(paidAmount),
      remaining_amount: normMoney(remainingAmount),
      payment_breakdown: paymentBreakdown,
      included_statuses: statuses,
      date_column_used: dateCol,
      delivery_column_used: deliveryCol || null,
      item_qty_column_used: itemQtyCol || null,
      item_price_column_used: itemPriceCol || null,
      item_price_mode: itemPurchasePriceCol
        ? "PURCHASE_PRICE_SNAPSHOT"
        : itemFallbackSalePriceCol
        ? "ORDER_ITEM_SALE_PRICE_FALLBACK"
        : "ORDER_SUMMARY_FALLBACK",
    },
  };
}

async function upsertReport({ period_type, anchorDate, currency = "MAD" }) {
  if (!PERIODS.includes(period_type)) {
    throw new Error("Invalid period_type");
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const { start, end } = getRangeForPeriod(period_type, anchorDate);

    const period_start = toDateSql(start);
    const period_end = toDateSql(end);

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
        String(currency).toUpperCase(),
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
      [period_type, String(currency).toUpperCase(), period_start, period_end]
    );

    await conn.commit();

    return saved || {
      period_type,
      period_start,
      period_end,
      currency: String(currency).toUpperCase(),
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
    where.push(`UPPER(currency) = ?`);
    params.push(String(currency).toUpperCase());
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
      from: toDateSql(startDate),
      to: toDateSql(endDate),
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