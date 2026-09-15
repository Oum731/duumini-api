const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const {
  upsertReport,
  backfillSalesReports,
  PERIODS,
} = require("../services/salesReports");

const router = Router();

function onlyDate(v) {
  if (!v) return null;
  return String(v).trim().slice(0, 10);
}

router.get("/sales", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const type = String(req.query.type || "DAILY").toUpperCase();
  const from = req.query.from ? onlyDate(req.query.from) : null;
  const to = req.query.to ? onlyDate(req.query.to) : null;
  const currency = String(req.query.currency || "MAD").toUpperCase();

  if (!PERIODS.includes(type)) {
    return res.status(400).json({ error: "Invalid period_type" });
  }

  const where = ["period_type = ?", "currency = ?"];
  const params = [type, currency];

  if (from && to) {
    where.push("period_end >= ?");
    where.push("period_start <= ?");
    params.push(from, to);
  } else if (from) {
    where.push("period_end >= ?");
    params.push(from);
  } else if (to) {
    where.push("period_start <= ?");
    params.push(to);
  }

  try {
    const [rows] = await getPool().query(
      `
      SELECT *
      FROM sales_reports
      WHERE ${where.join(" AND ")}
      ORDER BY period_start DESC, id DESC
      LIMIT 1000
      `,
      params
    );

    return res.json({ items: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get("/sales/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid id" });
  }

  try {
    const [[row]] = await getPool().query(
      `
      SELECT *
      FROM sales_reports
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!row) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/sales/run", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

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

    return res.json({ ok: true, report: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/sales/backfill", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

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

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/sales/backfill-all", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

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

    return res.json({
      ok: true,
      currency,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * ✅ NEW: Créances clients ("qui doit combien")
 * S'appuie sur orders.payment_status / paid_amount (déjà utilisés ailleurs,
 * ex. orders.js payCols) — vérifiés dynamiquement au cas où la migration
 * n'a pas encore été jouée sur cet environnement. Même logique de
 * regroupement client (compte ou invité via orders.contact) que le
 * portefeuille commercial (commercialProfiles.js /:userId/portfolio), pour
 * rester cohérent entre les deux vues.
 * =======================*/
async function detectOrdersPaymentCols(pool) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME IN ('payment_status', 'paid_amount')
    `
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return {
    payment_status: found.has("payment_status"),
    paid_amount: found.has("paid_amount"),
  };
}

router.get("/debts", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const pool = getPool();
    const payCols = await detectOrdersPaymentCols(pool);

    if (!payCols.payment_status || !payCols.paid_amount) {
      return res.status(409).json({
        error:
          "Colonnes orders.payment_status/paid_amount absentes sur cet environnement. Ajoute la migration puis réessaie.",
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        MAX(o.user_id) AS client_user_id,
        COALESCE(MAX(u.first_name), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.first_name'))), 'null')) AS first_name,
        COALESCE(MAX(u.last_name), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.last_name'))), 'null')) AS last_name,
        COALESCE(MAX(u.phone), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.phone'))), 'null')) AS phone,
        COUNT(*) AS orders_count,
        SUM(o.total) AS total_amount,
        SUM(COALESCE(o.paid_amount, 0)) AS paid_amount,
        SUM(o.total - COALESCE(o.paid_amount, 0)) AS amount_due,
        MAX(o.created_at) AS last_order_at
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status <> 'CANCELLED'
        AND COALESCE(o.payment_status, 'UNPAID') <> 'PAID'
      GROUP BY COALESCE(o.user_id, JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.phone')))
      HAVING amount_due > 0
      ORDER BY amount_due DESC
      LIMIT 500
      `
    );

    const items = (rows || []).map((r) => ({
      ...r,
      orders_count: Number(r.orders_count),
      total_amount: Number(r.total_amount),
      paid_amount: Number(r.paid_amount),
      amount_due: Number(r.amount_due),
    }));

    return res.json({
      items,
      total_amount_due: items.reduce((acc, r) => acc + r.amount_due, 0),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * ✅ NEW: Vue géographique des clients — où sont nos clients ?
 * Regroupe par ville extraite de orders.address (JSON) — c'est le champ le
 * plus fiable disponible sur une commande (voir buildAddressObj dans
 * orders.js), plus robuste que orders.contact qui n'est renseigné que côté
 * "qui contacter" et pas toujours pour les comptes existants.
 * =======================*/
// Villes connues sous plusieurs graphies dans les commandes (faute de
// frappe courante, ex: "Dhakla" pour "Dakhla") : la collation ci-dessous
// fusionne déjà casse + accents (Casablanca/CASABLANCA/casablanca,
// Fes/Fès...), mais pas les vraies variantes orthographiques.
const CITY_ALIASES = { dhakla: "dakhla" };
const CITY_LABELS = {
  casablanca: "Casablanca",
  marrakech: "Marrakech",
  rabat: "Rabat",
  agadir: "Agadir",
  fes: "Fès",
  meknes: "Meknès",
  kenitra: "Kénitra",
  tanger: "Tanger",
  dakhla: "Dakhla",
  sale: "Salé",
  settat: "Settat",
  izgane: "Inezgane",
  hoceima: "Al Hoceïma",
  oujda: "Oujda",
  mohammedia: "Mohammedia",
  benguerir: "Benguerir",
  bouskoura: "Bouskoura",
  laayoune: "Laâyoune",
  "ville inconnue": "Ville inconnue",
  autre: "Autre",
};

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function titleCase(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

router.get("/clients-by-zone", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const pool = getPool();

    // JSON_UNQUOTE()/JSON_EXTRACT() renvoient une chaîne en collation
    // utf8mb4_bin (sensible à la casse ET aux accents), ce qui faisait
    // apparaître "Casablanca"/"CASABLANCA"/"casablanca" comme 3 villes
    // distinctes. On recolle une collation insensible à la casse et aux
    // accents pour le regroupement.
    const [rows] = await pool.query(
      `
      SELECT
        LOWER(TRIM(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(o.address, '$.city')), 'null'), 'Ville inconnue')))
          COLLATE utf8mb4_general_ci AS city_key,
        COUNT(*) AS orders_count,
        COUNT(DISTINCT COALESCE(o.user_id, JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.phone')))) AS clients_count,
        SUM(o.total) AS total_amount
      FROM orders o
      WHERE o.status <> 'CANCELLED'
      GROUP BY city_key
      `
    );

    const merged = new Map();
    for (const r of rows || []) {
      let asciiKey = stripAccents(r.city_key).toLowerCase().trim();
      asciiKey = CITY_ALIASES[asciiKey] || asciiKey;
      const label = CITY_LABELS[asciiKey] || titleCase(asciiKey);

      const prev = merged.get(asciiKey);
      if (prev) {
        prev.orders_count += Number(r.orders_count);
        prev.clients_count += Number(r.clients_count);
        prev.total_amount += Number(r.total_amount);
      } else {
        merged.set(asciiKey, {
          city: label,
          orders_count: Number(r.orders_count),
          clients_count: Number(r.clients_count),
          total_amount: Number(r.total_amount),
        });
      }
    }

    const items = Array.from(merged.values())
      .sort((a, b) => b.clients_count - a.clients_count || b.total_amount - a.total_amount)
      .slice(0, 100);

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;