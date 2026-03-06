const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const {
  upsertReport,
  backfillSalesReports,
  PERIODS,
} = require("../services/salesReports");

const router = Router();

router.get("/sales", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const type = String(req.query.type || "DAILY").toUpperCase();
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  const currency = String(req.query.currency || "MAD").toUpperCase();

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
      LIMIT 1000
      `,
      params
    );

    res.json({ items: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/sales/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  try {
    const [[row]] = await getPool().query(
      `SELECT * FROM sales_reports WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!row) return res.status(404).json({ error: "Not found" });

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/sales/run", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const period_type = String(req.body?.period_type || "DAILY").toUpperCase();
  const date = req.body?.date ? new Date(req.body.date) : new Date();
  const currency = String(req.body?.currency || "MAD").toUpperCase();

  if (!PERIODS.includes(period_type)) {
    return res.status(400).json({ error: "Invalid period_type" });
  }

  try {
    const out = await upsertReport({
      period_type,
      anchorDate: date,
      currency,
    });

    res.json({ ok: true, report: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/sales/backfill", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const period_type = String(req.body?.period_type || "DAILY").toUpperCase();
  const currency = String(req.body?.currency || "MAD").toUpperCase();
  const fromDate = req.body?.fromDate ? new Date(req.body.fromDate) : null;
  const toDate = req.body?.toDate ? new Date(req.body.toDate) : new Date();

  if (!PERIODS.includes(period_type)) {
    return res.status(400).json({ error: "Invalid period_type" });
  }

  try {
    const out = await backfillSalesReports({
      period_type,
      currency,
      fromDate,
      toDate,
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/sales/backfill-all", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const currency = String(req.body?.currency || "MAD").toUpperCase();
  const fromDate = req.body?.fromDate ? new Date(req.body.fromDate) : null;
  const toDate = req.body?.toDate ? new Date(req.body.toDate) : new Date();

  try {
    const results = [];

    for (const period_type of PERIODS) {
      const out = await backfillSalesReports({
        period_type,
        currency,
        fromDate,
        toDate,
      });
      results.push(out);
    }

    res.json({
      ok: true,
      currency,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;