// src/routes/subscriptions.js
//
// Module Abonnements (Phase 4) : une entreprise (companies) souscrit à un
// plan pour débloquer les outils de gestion Duumini. V1 volontairement
// simple — activation/renouvellement/annulation à la main par l'admin,
// pas de passerelle de paiement. Ce module ne restreint encore l'accès à
// aucune page existante : il pose juste le modèle et l'écran de gestion.
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, optionalAuth, isAdmin } = require("../middlewares/auth");
const { actingUserId, getActiveMembership } = require("../utils/companyAccess");

const router = Router();

function toPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function toDateOnly(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function requireAdminOrCompanyOwner(req, res, companyId) {
  if (isAdmin(req.user)) return true;

  const actorId = actingUserId(req);
  const membership = actorId ? await getActiveMembership(companyId, actorId) : null;

  if (!membership || membership.internal_role !== "OWNER") {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }

  return true;
}

/**
 * Une souscription est stockée avec un `status` explicite (mis à jour par
 * l'admin), mais les dates peuvent avoir expiré depuis sans qu'aucune
 * action manuelle n'ait eu lieu. `effective_status` reflète la réalité au
 * moment de la lecture, sans jamais réécrire silencieusement la base — un
 * TRIAL/ACTIVE expiré doit rester visible comme tel jusqu'à ce que l'admin
 * agisse (renouvellement ou annulation), pour garder une trace propre.
 */
function computeEffectiveStatus(sub) {
  if (!sub) return null;

  const today = new Date().toISOString().slice(0, 10);

  if (sub.status === "TRIAL" && sub.trial_ends_at && sub.trial_ends_at < today) {
    return "EXPIRED";
  }

  if (sub.status === "ACTIVE" && sub.current_period_end && sub.current_period_end < today) {
    return "EXPIRED";
  }

  return sub.status;
}

/* =========================
 * GET /api/subscriptions/plans
 * Public : plans actifs uniquement. Admin (?all=1) : tous, y compris inactifs.
 * ======================= */
router.get("/plans", optionalAuth, async (req, res) => {
  try {
    const pool = getPool();
    const onlyActive = !(req.query.all === "1" && isAdmin(req.user));

    const [rows] = await pool.query(
      `SELECT * FROM subscription_plans ${onlyActive ? "WHERE is_active = 1" : ""} ORDER BY price_amount ASC`,
    );

    return res.json({ items: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/subscriptions/plans (ADMIN)
 * ======================= */
router.post("/plans", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const code = String(req.body?.code || "").trim().toUpperCase();
  const name = String(req.body?.name || "").trim();
  const description = req.body?.description ? String(req.body.description).trim() : null;
  const priceAmount = Number(req.body?.price_amount);
  const priceCurrency = String(req.body?.price_currency || "MAD").trim().toUpperCase();
  const billingCycle = String(req.body?.billing_cycle || "MONTHLY").trim().toUpperCase();
  const trialDays = Number.isFinite(Number(req.body?.trial_days)) ? Math.max(0, Number(req.body.trial_days)) : 0;

  if (!code || !name) return res.status(400).json({ error: "code and name are required" });
  if (!Number.isFinite(priceAmount) || priceAmount < 0) {
    return res.status(400).json({ error: "price_amount invalid" });
  }
  if (!["MONTHLY", "YEARLY"].includes(billingCycle)) {
    return res.status(400).json({ error: "billing_cycle must be MONTHLY or YEARLY" });
  }

  try {
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO subscription_plans
        (code, name, description, price_amount, price_currency, billing_cycle, trial_days, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [code, name, description, priceAmount, priceCurrency, billingCycle, trialDays],
    );
    return res.status(201).json({ id: r.insertId, ok: true });
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A plan with this code already exists" });
    }
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * PATCH /api/subscriptions/plans/:id (ADMIN)
 * ======================= */
router.patch("/plans/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const fields = ["name", "description", "price_amount", "price_currency", "billing_cycle", "trial_days", "is_active"];
  const sets = [];
  const vals = [];

  for (const f of fields) {
    if (req.body?.[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(f === "is_active" ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }

  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  try {
    vals.push(id);
    await getPool().query(`UPDATE subscription_plans SET ${sets.join(", ")} WHERE id = ?`, vals);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * GET /api/subscriptions/companies (ADMIN)
 * Vue d'ensemble : toutes les entreprises + leur abonnement courant.
 * ======================= */
router.get("/companies", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `
      SELECT
        c.id AS company_id, c.legal_name, c.slug, c.supplier_type, c.is_active AS company_is_active,
        cs.id AS subscription_id, cs.plan_id, cs.status, cs.trial_ends_at, cs.current_period_end,
        cs.note, cs.updated_at AS subscription_updated_at,
        p.name AS plan_name, p.code AS plan_code
      FROM companies c
      LEFT JOIN company_subscriptions cs ON cs.company_id = c.id
      LEFT JOIN subscription_plans p ON p.id = cs.plan_id
      ORDER BY c.created_at DESC
      `,
    );

    const items = (rows || []).map((r) => ({
      ...r,
      effective_status: r.subscription_id
        ? computeEffectiveStatus({ status: r.status, trial_ends_at: r.trial_ends_at, current_period_end: r.current_period_end })
        : "NONE",
    }));

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * GET /api/subscriptions/companies/:companyId
 * Admin ou OWNER de l'entreprise : détail + historique.
 * ======================= */
router.get("/companies/:companyId", authRequired, async (req, res) => {
  const companyId = toPosInt(req.params.companyId);
  if (!companyId) return res.status(400).json({ error: "Invalid companyId" });

  if (!(await requireAdminOrCompanyOwner(req, res, companyId))) return;

  try {
    const pool = getPool();

    const [[sub]] = await pool.query(
      `
      SELECT cs.*, p.name AS plan_name, p.code AS plan_code, p.price_amount, p.price_currency, p.billing_cycle
      FROM company_subscriptions cs
      LEFT JOIN subscription_plans p ON p.id = cs.plan_id
      WHERE cs.company_id = ?
      LIMIT 1
      `,
      [companyId],
    );

    const [events] = await pool.query(
      `
      SELECT e.id, e.event_type, e.plan_id, e.performed_by, e.note, e.created_at,
             p.name AS plan_name,
             u.first_name AS performed_by_first_name, u.last_name AS performed_by_last_name
      FROM company_subscription_events e
      LEFT JOIN subscription_plans p ON p.id = e.plan_id
      LEFT JOIN users u ON u.id = e.performed_by
      WHERE e.company_id = ?
      ORDER BY e.created_at DESC
      `,
      [companyId],
    );

    return res.json({
      subscription: sub ? { ...sub, effective_status: computeEffectiveStatus(sub) } : null,
      events: events || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/subscriptions/companies/:companyId/start-trial (ADMIN)
 * Body: { plan_id, trial_days? (sinon celui du plan), note? }
 * ======================= */
router.post("/companies/:companyId/start-trial", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const companyId = toPosInt(req.params.companyId);
  const planId = toPosInt(req.body?.plan_id);
  if (!companyId) return res.status(400).json({ error: "Invalid companyId" });
  if (!planId) return res.status(400).json({ error: "plan_id is required" });

  const note = req.body?.note ? String(req.body.note).trim() : null;

  try {
    const pool = getPool();
    const [[plan]] = await pool.query(`SELECT id, trial_days FROM subscription_plans WHERE id = ?`, [planId]);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const trialDays = req.body?.trial_days != null ? Math.max(0, Number(req.body.trial_days)) : Number(plan.trial_days || 0);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);
    const trialEndsAtStr = trialEndsAt.toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO company_subscriptions
        (company_id, plan_id, status, trial_ends_at, current_period_end, activated_by, note)
       VALUES (?, ?, 'TRIAL', ?, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
        plan_id = VALUES(plan_id), status = 'TRIAL', trial_ends_at = VALUES(trial_ends_at),
        current_period_end = NULL, activated_by = VALUES(activated_by), note = VALUES(note)`,
      [companyId, planId, trialEndsAtStr, req.user.id, note],
    );

    await pool.query(
      `INSERT INTO company_subscription_events (company_id, event_type, plan_id, performed_by, note)
       VALUES (?, 'TRIAL_STARTED', ?, ?, ?)`,
      [companyId, planId, req.user.id, note],
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/subscriptions/companies/:companyId/activate (ADMIN)
 * Body: { plan_id, current_period_end (YYYY-MM-DD), note? }
 * ======================= */
router.post("/companies/:companyId/activate", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const companyId = toPosInt(req.params.companyId);
  const planId = toPosInt(req.body?.plan_id);
  const periodEnd = toDateOnly(req.body?.current_period_end);
  if (!companyId) return res.status(400).json({ error: "Invalid companyId" });
  if (!planId) return res.status(400).json({ error: "plan_id is required" });
  if (!periodEnd) return res.status(400).json({ error: "current_period_end (YYYY-MM-DD) is required" });

  const note = req.body?.note ? String(req.body.note).trim() : null;

  try {
    const pool = getPool();
    const [[plan]] = await pool.query(`SELECT id FROM subscription_plans WHERE id = ?`, [planId]);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const [[existing]] = await pool.query(
      `SELECT id FROM company_subscriptions WHERE company_id = ? LIMIT 1`,
      [companyId],
    );

    await pool.query(
      `INSERT INTO company_subscriptions
        (company_id, plan_id, status, trial_ends_at, current_period_end, activated_by, note)
       VALUES (?, ?, 'ACTIVE', NULL, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        plan_id = VALUES(plan_id), status = 'ACTIVE', current_period_end = VALUES(current_period_end),
        activated_by = VALUES(activated_by), note = VALUES(note)`,
      [companyId, planId, periodEnd, req.user.id, note],
    );

    await pool.query(
      `INSERT INTO company_subscription_events (company_id, event_type, plan_id, performed_by, note)
       VALUES (?, ?, ?, ?, ?)`,
      [companyId, existing ? "RENEWED" : "ACTIVATED", planId, req.user.id, note],
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/subscriptions/companies/:companyId/cancel (ADMIN)
 * ======================= */
router.post("/companies/:companyId/cancel", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const companyId = toPosInt(req.params.companyId);
  if (!companyId) return res.status(400).json({ error: "Invalid companyId" });

  const note = req.body?.note ? String(req.body.note).trim() : null;

  try {
    const pool = getPool();
    const [r] = await pool.query(
      `UPDATE company_subscriptions SET status = 'CANCELLED', note = ? WHERE company_id = ?`,
      [note, companyId],
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "No subscription found for this company" });
    }

    await pool.query(
      `INSERT INTO company_subscription_events (company_id, event_type, performed_by, note)
       VALUES (?, 'CANCELLED', ?, ?)`,
      [companyId, req.user.id, note],
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
