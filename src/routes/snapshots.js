const { Router } = require("express");
const { getPool } = require("../lib/db");
let authRequired, isAdmin;

try {
  ({ authRequired, isAdmin } = require("../middlewares/auth"));
} catch {}

const router = Router();

/* =========================
 * Helpers
 * =======================*/
function isValidMonthKey(k) {
  return /^\d{4}\-(0[1-9]|1[0-2])$/.test(String(k || ""));
}
function isValidYearKey(k) {
  return /^\d{4}$/.test(String(k || ""));
}

async function tableHasColumn(conn, table, col) {
  const [[r]] = await conn.query(
    `
    SELECT 1 AS ok
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1
    `,
    [table, col]
  );
  return !!r;
}

async function detectOrdersCols(conn) {
  const cols = {
    done_at: await tableHasColumn(conn, "orders", "done_at"),
    updated_at: await tableHasColumn(conn, "orders", "updated_at"),
    created_at: await tableHasColumn(conn, "orders", "created_at"),
    items_amount: await tableHasColumn(conn, "orders", "items_amount"),
    delivery_fee: await tableHasColumn(conn, "orders", "delivery_fee"),
    totals: await tableHasColumn(conn, "orders", "totals"),
    commission_duumini: await tableHasColumn(conn, "orders", "commission_duumini"),
    total: await tableHasColumn(conn, "orders", "total"),
    status: await tableHasColumn(conn, "orders", "status"),
  };
  return cols;
}

/**
 * Retourne une expression SQL DATE(...) fiable pour "date DONE"
 */
function doneDateExpr(cols) {
  if (cols.done_at) return "DATE(o.done_at)";
  if (cols.updated_at && cols.created_at) return "DATE(COALESCE(o.updated_at, o.created_at))";
  if (cols.updated_at) return "DATE(o.updated_at)";
  return "DATE(o.created_at)";
}

/**
 * Items amount : priorité = orders.items_amount si existe
 * sinon = somme order_items
 */
function itemsAmountExpr(cols) {
  if (cols.items_amount) return "COALESCE(o.items_amount, 0)";
  return `COALESCE((SELECT SUM(oi.qty * oi.unit_price) FROM order_items oi WHERE oi.order_id = o.id), 0)`;
}

/**
 * Total : priorité = orders.total si existe
 * sinon = items_amount + delivery_fee (si delivery_fee existe)
 * sinon = items_amount
 */
function totalAmountExpr(cols) {
  if (cols.total) return "COALESCE(o.total, 0)";
  if (cols.delivery_fee) return `(${itemsAmountExpr(cols)} + COALESCE(o.delivery_fee, 0))`;
  // si totals JSON existe, on tente d’en extraire "amount"
  if (cols.totals) {
    return `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.totals, '$.amount')) + 0, ${itemsAmountExpr(cols)})`;
  }
  return itemsAmountExpr(cols);
}

/**
 * Commission : priorité = orders.commission_duumini si existe
 * sinon 0
 */
function commissionExpr(cols) {
  if (cols.commission_duumini) return "COALESCE(o.commission_duumini, 0)";
  return "0";
}

/**
 * Filtre statut DONE : si colonne status existe.
 * Tu as chez toi DONE et CANCELLED etc.
 */
function doneWhereExpr(cols) {
  if (cols.status) return `UPPER(TRIM(o.status)) = 'DONE'`;
  // si pas de status, on prend tout
  return "1=1";
}

/* =========================
 * Core snapshot builders
 * =======================*/
async function upsertMonthlySnapshot(pkey) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const cols = await detectOrdersCols(conn);

    const startExpr = `DATE(CONCAT(?, '-01'))`;
    const endExpr = `LAST_DAY(DATE(CONCAT(?, '-01')))`;

    const dExpr = doneDateExpr(cols);
    const itemsExpr = itemsAmountExpr(cols);
    const totalExpr = totalAmountExpr(cols);
    const commExpr = commissionExpr(cols);
    const whereDone = doneWhereExpr(cols);

    const sql = `
      INSERT INTO sales_snapshots (
        period_type, period_key, start_date, end_date,
        orders_done, items_amount, delivery_amount, total_amount, duumini_commission
      )
      SELECT
        'MONTH' AS period_type,
        ?      AS period_key,
        ${startExpr} AS start_date,
        ${endExpr}   AS end_date,

        COUNT(*) AS orders_done,
        ROUND(SUM(x.items_amount), 2) AS items_amount,
        ROUND(SUM(GREATEST(0, x.total_amount - x.items_amount)), 2) AS delivery_amount,
        ROUND(SUM(x.total_amount), 2) AS total_amount,
        ROUND(SUM(x.commission_duumini), 2) AS duumini_commission
      FROM (
        SELECT
          o.id,
          ${totalExpr} AS total_amount,
          ${commExpr}  AS commission_duumini,
          ${itemsExpr} AS items_amount
        FROM orders o
        WHERE ${whereDone}
          AND ${dExpr} >= ${startExpr}
          AND ${dExpr} <= ${endExpr}
      ) x
      ON DUPLICATE KEY UPDATE
        start_date = VALUES(start_date),
        end_date   = VALUES(end_date),
        orders_done = VALUES(orders_done),
        items_amount = VALUES(items_amount),
        delivery_amount = VALUES(delivery_amount),
        total_amount = VALUES(total_amount),
        duumini_commission = VALUES(duumini_commission)
    `;

    // placeholders:
    // 1) period_key
    // 2) startExpr key
    // 3) endExpr key
    // 4) startExpr key in WHERE
    // 5) endExpr key in WHERE
    const params = [pkey, pkey, pkey, pkey, pkey];

    await conn.query(sql, params);

    const [[row]] = await conn.query(
      `SELECT * FROM sales_snapshots WHERE period_type='MONTH' AND period_key=? LIMIT 1`,
      [pkey]
    );
    return row;
  } finally {
    conn.release();
  }
}

async function upsertYearlySnapshot(ykey) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const cols = await detectOrdersCols(conn);

    const startExpr = `DATE(CONCAT(?, '-01-01'))`;
    const endExpr = `DATE(CONCAT(?, '-12-31'))`;

    const dExpr = doneDateExpr(cols);
    const itemsExpr = itemsAmountExpr(cols);
    const totalExpr = totalAmountExpr(cols);
    const commExpr = commissionExpr(cols);
    const whereDone = doneWhereExpr(cols);

    const sql = `
      INSERT INTO sales_snapshots (
        period_type, period_key, start_date, end_date,
        orders_done, items_amount, delivery_amount, total_amount, duumini_commission
      )
      SELECT
        'YEAR' AS period_type,
        ?     AS period_key,
        ${startExpr} AS start_date,
        ${endExpr}   AS end_date,

        COUNT(*) AS orders_done,
        ROUND(SUM(x.items_amount), 2) AS items_amount,
        ROUND(SUM(GREATEST(0, x.total_amount - x.items_amount)), 2) AS delivery_amount,
        ROUND(SUM(x.total_amount), 2) AS total_amount,
        ROUND(SUM(x.commission_duumini), 2) AS duumini_commission
      FROM (
        SELECT
          o.id,
          ${totalExpr} AS total_amount,
          ${commExpr}  AS commission_duumini,
          ${itemsExpr} AS items_amount
        FROM orders o
        WHERE ${whereDone}
          AND ${dExpr} >= ${startExpr}
          AND ${dExpr} <= ${endExpr}
      ) x
      ON DUPLICATE KEY UPDATE
        start_date = VALUES(start_date),
        end_date   = VALUES(end_date),
        orders_done = VALUES(orders_done),
        items_amount = VALUES(items_amount),
        delivery_amount = VALUES(delivery_amount),
        total_amount = VALUES(total_amount),
        duumini_commission = VALUES(duumini_commission)
    `;

    const params = [ykey, ykey, ykey, ykey, ykey];

    await conn.query(sql, params);

    const [[row]] = await conn.query(
      `SELECT * FROM sales_snapshots WHERE period_type='YEAR' AND period_key=? LIMIT 1`,
      [ykey]
    );
    return row;
  } finally {
    conn.release();
  }
}

/* =========================
 * Routes (admin only)
 * =======================*/
const protectAdmin = [];
if (authRequired && isAdmin) protectAdmin.push(authRequired, isAdmin);

router.post("/month", ...protectAdmin, async (req, res) => {
  const key = String(req.query.key || req.body?.key || "").trim();
  if (!isValidMonthKey(key)) return res.status(400).json({ error: "Invalid month key. ex: 2025-12" });

  try {
    const snap = await upsertMonthlySnapshot(key);
    return res.json(snap);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/year", ...protectAdmin, async (req, res) => {
  const key = String(req.query.key || req.body?.key || "").trim();
  if (!isValidYearKey(key)) return res.status(400).json({ error: "Invalid year key. ex: 2025" });

  try {
    const snap = await upsertYearlySnapshot(key);
    return res.json(snap);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get("/", ...protectAdmin, async (req, res) => {
  const pool = getPool();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  try {
    const [rows] = await pool.query(
      `SELECT * FROM sales_snapshots ORDER BY start_date DESC, id DESC LIMIT ?`,
      [limit]
    );
    return res.json({ items: rows });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;

// (optionnel) export fonctions si tu veux les appeler depuis un cron
module.exports.upsertMonthlySnapshot = upsertMonthlySnapshot;
module.exports.upsertYearlySnapshot = upsertYearlySnapshot;
