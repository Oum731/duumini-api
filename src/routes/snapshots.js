// src/routes/snapshots.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");

const router = Router();

function isValidMonthKey(pkey) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(pkey || "").trim());
}
function isValidYearKey(y) {
  return /^\d{4}$/.test(String(y || "").trim());
}

/**
 * IMPORTANT: ton schema n'a PAS done_at (tu as eu #1054).
 * Donc on comptabilise sur DATE(COALESCE(updated_at, created_at))
 * car tes commandes DONE sont mises à jour quand tu changes le status.
 *
 * Si tu ajoutes done_at plus tard, on pourra basculer dessus.
 */
async function upsertMonthlySnapshot(pkey) {
  const pool = getPool();

  const sql = `
  INSERT INTO sales_snapshots (
    period_type, period_key, start_date, end_date,
    orders_done, items_amount, delivery_amount, total_amount, duumini_commission
  )
  SELECT
    'MONTH' AS period_type,
    ?       AS period_key,
    DATE(CONCAT(?,'-01')) AS start_date,
    LAST_DAY(DATE(CONCAT(?,'-01'))) AS end_date,

    COUNT(*) AS orders_done,

    ROUND(SUM(x.items_amount), 2) AS items_amount,
    ROUND(SUM(GREATEST(0, x.total_amount - x.items_amount)), 2) AS delivery_amount,
    ROUND(SUM(x.total_amount), 2) AS total_amount,
    ROUND(SUM(x.commission_duumini), 2) AS duumini_commission
  FROM (
    SELECT
      o.id,
      COALESCE(o.total, 0) AS total_amount,
      COALESCE(o.commission_duumini, 0) AS commission_duumini,
      COALESCE(
        (SELECT SUM(oi.qty * oi.unit_price)
         FROM order_items oi
         WHERE oi.order_id = o.id),
        0
      ) AS items_amount,
      DATE(COALESCE(o.updated_at, o.created_at)) AS done_date
    FROM orders o
    WHERE UPPER(TRIM(o.status)) = 'DONE'
  ) x
  WHERE x.done_date >= DATE(CONCAT(?,'-01'))
    AND x.done_date <= LAST_DAY(DATE(CONCAT(?,'-01')))
  ON DUPLICATE KEY UPDATE
    start_date = VALUES(start_date),
    end_date   = VALUES(end_date),
    orders_done = VALUES(orders_done),
    items_amount = VALUES(items_amount),
    delivery_amount = VALUES(delivery_amount),
    total_amount = VALUES(total_amount),
    duumini_commission = VALUES(duumini_commission),
    created_at = CURRENT_TIMESTAMP
  `;

  await pool.query(sql, [pkey, pkey, pkey, pkey, pkey]);
}

async function upsertYearlySnapshot(yearKey) {
  const pool = getPool();
  const y = String(yearKey);

  const sql = `
  INSERT INTO sales_snapshots (
    period_type, period_key, start_date, end_date,
    orders_done, items_amount, delivery_amount, total_amount, duumini_commission
  )
  SELECT
    'YEAR' AS period_type,
    ?      AS period_key,
    DATE(CONCAT(?,'-01-01')) AS start_date,
    DATE(CONCAT(?,'-12-31')) AS end_date,

    COUNT(*) AS orders_done,

    ROUND(SUM(x.items_amount), 2) AS items_amount,
    ROUND(SUM(GREATEST(0, x.total_amount - x.items_amount)), 2) AS delivery_amount,
    ROUND(SUM(x.total_amount), 2) AS total_amount,
    ROUND(SUM(x.commission_duumini), 2) AS duumini_commission
  FROM (
    SELECT
      o.id,
      COALESCE(o.total, 0) AS total_amount,
      COALESCE(o.commission_duumini, 0) AS commission_duumini,
      COALESCE(
        (SELECT SUM(oi.qty * oi.unit_price)
         FROM order_items oi
         WHERE oi.order_id = o.id),
        0
      ) AS items_amount,
      DATE(COALESCE(o.updated_at, o.created_at)) AS done_date
    FROM orders o
    WHERE UPPER(TRIM(o.status)) = 'DONE'
  ) x
  WHERE x.done_date >= DATE(CONCAT(?,'-01-01'))
    AND x.done_date <= DATE(CONCAT(?,'-12-31'))
  ON DUPLICATE KEY UPDATE
    start_date = VALUES(start_date),
    end_date   = VALUES(end_date),
    orders_done = VALUES(orders_done),
    items_amount = VALUES(items_amount),
    delivery_amount = VALUES(delivery_amount),
    total_amount = VALUES(total_amount),
    duumini_commission = VALUES(duumini_commission),
    created_at = CURRENT_TIMESTAMP
  `;

  await pool.query(sql, [y, y, y, y, y]);
}

/**
 * POST /api/snapshots/month?key=2025-12
 * ADMIN only
 */
router.post("/month", authRequired, requireRole("ADMIN"), async (req, res) => {
  const key = String(req.query.key || "").trim();
  if (!isValidMonthKey(key)) {
    return res.status(400).json({ error: "key must be YYYY-MM (ex: 2025-12)" });
  }
  try {
    await upsertMonthlySnapshot(key);
    res.json({ ok: true, period_type: "MONTH", period_key: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/snapshots/year?key=2025
 * ADMIN only
 */
router.post("/year", authRequired, requireRole("ADMIN"), async (req, res) => {
  const key = String(req.query.key || "").trim();
  if (!isValidYearKey(key)) {
    return res.status(400).json({ error: "key must be YYYY (ex: 2025)" });
  }
  try {
    await upsertYearlySnapshot(key);
    res.json({ ok: true, period_type: "YEAR", period_key: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/snapshots?type=MONTH&key=2025-12   (optionnel mais utile)
 */
router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();
  const type = String(req.query.type || "").toUpperCase();
  const key = String(req.query.key || "").trim();

  const where = [];
  const params = [];
  if (type) { where.push("period_type=?"); params.push(type); }
  if (key)  { where.push("period_key=?"); params.push(key); }

  const sql = `
    SELECT *
    FROM sales_snapshots
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY start_date DESC, id DESC
    LIMIT 50
  `;

  const [rows] = await pool.query(sql, params);
  res.json({ items: rows });
});

module.exports = router;
