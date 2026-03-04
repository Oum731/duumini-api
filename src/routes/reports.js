// src/routes/reports.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { upsertReport } = require("../services/salesReports");

const router = Router();

/**
 * LIST reports (admin) : filtre type + dates
 * GET /api/reports/sales?type=DAILY&from=2026-03-01&to=2026-03-31&currency=MAD
 */
router.get("/sales", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const type = String(req.query.type || "DAILY").trim().toUpperCase();
  const from = req.query.from ? String(req.query.from).trim() : null;
  const to = req.query.to ? String(req.query.to).trim() : null;
  const currency = String(req.query.currency || "MAD").trim().toUpperCase();

  const where = ["period_type = ?", "currency = ?"];
  const params = [type, currency];

  if (from) {
    where.push("period_start >= ?");
    params.push(from);
  }
  if (to) {
    where.push("period_end <= ?");
    params.push(to);
  }

  try {
    const [rows] = await getPool().query(
      `
      SELECT *
      FROM sales_reports
      WHERE ${where.join(" AND ")}
      ORDER BY period_start DESC
      LIMIT 500
      `,
      params,
    );

    return res.json({ items: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET one report
 * GET /api/reports/sales/:id
 */
router.get("/sales/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  try {
    const [[row]] = await getPool().query(
      `SELECT * FROM sales_reports WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * RUN/REBUILD report (admin) — utile pour cron ou si tu veux recalculer
 * POST /api/reports/sales/run { period_type, date, currency }
 */
router.post("/sales/run", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const period_type = String(req.body?.period_type || "DAILY")
    .trim()
    .toUpperCase();

  const anchorDate = req.body?.date ? new Date(req.body.date) : new Date();

  const currency = String(req.body?.currency || "MAD").trim().toUpperCase();

  try {
    const out = await upsertReport({ period_type, anchorDate, currency });
    return res.json({ ok: true, report: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;