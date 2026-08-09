// src/routes/commercialProfiles.js
// Profils commercial : taux de commission individuel, solde dû, CA
// généré et portefeuille client — dérivés directement des commandes
// (orders.commercial_id), posées via POST /api/orders/admin. Patron
// direct de livreurProfiles.js (même logique solde dû / règlement),
// adapté aux commandes plutôt qu'aux courses.

const { Router } = require("express");

const { getPool } = require("../lib/db");
const { authRequired, requireRole, requireCapability, isCommercial } = require("../middlewares/auth");

const router = Router();

/* ========= GET /me ========= */
/* Le commercial connecté consulte son propre CA du mois, ses commandes,
   ses clients et son solde de commission dû. */
router.get("/me", authRequired, requireCapability(isCommercial, "COMMERCIAL"), async (req, res) => {
  try {
    const pool = getPool();

    const [[profile]] = await pool.query(
      `SELECT user_id, commission_rate, created_at
         FROM commercial_profiles WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!profile) {
      return res.status(404).json({ error: "Profil commercial introuvable" });
    }

    const [[monthAgg]] = await pool.query(
      `SELECT
         COALESCE(SUM(total), 0) AS revenue_month,
         COUNT(*) AS orders_month,
         COUNT(DISTINCT user_id) AS clients_month
       FROM orders
      WHERE commercial_id = ?
        AND YEAR(created_at) = YEAR(CURDATE())
        AND MONTH(created_at) = MONTH(CURDATE())`,
      [req.user.id]
    );

    const [[{ due }]] = await pool.query(
      `SELECT COALESCE(SUM(commercial_commission_amount), 0) AS due
         FROM orders
        WHERE commercial_id = ? AND commercial_commission_status = 'PENDING'`,
      [req.user.id]
    );

    res.json({
      ...profile,
      commission_rate: Number(profile.commission_rate),
      revenue_month: Number(monthAgg.revenue_month),
      orders_month: Number(monthAgg.orders_month),
      clients_month: Number(monthAgg.clients_month),
      pending_commission: Number(due),
    });
  } catch (e) {
    console.error("GET /api/commercial-profiles/me error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET / ========= */
/* Admin : classement de tous les commerciaux — CA du mois, nb commandes,
   nb clients, solde dû. Trié par CA décroissant (le score validé). */
router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT
         cp.user_id, cp.commission_rate, cp.created_at,
         u.phone, u.first_name, u.last_name,
         COALESCE((
           SELECT SUM(o.total)
             FROM orders o
            WHERE o.commercial_id = cp.user_id
              AND YEAR(o.created_at) = YEAR(CURDATE())
              AND MONTH(o.created_at) = MONTH(CURDATE())
         ), 0) AS revenue_month,
         COALESCE((
           SELECT COUNT(*)
             FROM orders o
            WHERE o.commercial_id = cp.user_id
              AND YEAR(o.created_at) = YEAR(CURDATE())
              AND MONTH(o.created_at) = MONTH(CURDATE())
         ), 0) AS orders_month,
         COALESCE((
           SELECT COUNT(DISTINCT o.user_id)
             FROM orders o
            WHERE o.commercial_id = cp.user_id
              AND YEAR(o.created_at) = YEAR(CURDATE())
              AND MONTH(o.created_at) = MONTH(CURDATE())
         ), 0) AS clients_month,
         COALESCE((
           SELECT SUM(o.commercial_commission_amount)
             FROM orders o
            WHERE o.commercial_id = cp.user_id
              AND o.commercial_commission_status = 'PENDING'
         ), 0) AS pending_commission
       FROM commercial_profiles cp
       JOIN users u ON u.id = cp.user_id
       ORDER BY revenue_month DESC`
    );

    res.json({
      items: rows.map((r) => ({
        ...r,
        commission_rate: Number(r.commission_rate),
        revenue_month: Number(r.revenue_month),
        orders_month: Number(r.orders_month),
        clients_month: Number(r.clients_month),
        pending_commission: Number(r.pending_commission),
      })),
    });
  } catch (e) {
    console.error("GET /api/commercial-profiles error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /:userId/portfolio ========= */
/* Admin : portefeuille client d'un commercial — dérivé directement des
   commandes, pas de table dédiée (V1). */
router.get(
  "/:userId/portfolio",
  authRequired,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId) || 0;
      if (!userId) return res.status(400).json({ error: "Invalid userId" });

      const pool = getPool();
      // ✅ Beaucoup de commandes déclarées par un commercial sont des
      // commandes invité (orders.user_id NULL, ex: #609/Désiré) : le nom/
      // téléphone du compte (u.*) est alors vide. On retombe sur
      // orders.contact (le nom réellement saisi pour cette commande) — et
      // on regroupe par téléphone du contact quand il n'y a pas de compte,
      // pour ne pas éclater/mélanger les clients invités entre eux.
      const [rows] = await pool.query(
        `SELECT
           MAX(o.user_id) AS client_user_id,
           COALESCE(MAX(u.first_name), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.first_name'))), 'null')) AS first_name,
           COALESCE(MAX(u.last_name), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.last_name'))), 'null')) AS last_name,
           COALESCE(MAX(u.phone), NULLIF(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.phone'))), 'null')) AS phone,
           COUNT(*) AS orders_count,
           SUM(o.total) AS revenue_total,
           MAX(o.created_at) AS last_order_at
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
        WHERE o.commercial_id = ?
        GROUP BY COALESCE(o.user_id, JSON_UNQUOTE(JSON_EXTRACT(o.contact, '$.phone')))
        ORDER BY revenue_total DESC`,
        [userId]
      );

      res.json({
        items: rows.map((r) => ({
          ...r,
          orders_count: Number(r.orders_count),
          revenue_total: Number(r.revenue_total),
        })),
      });
    } catch (e) {
      console.error("GET /api/commercial-profiles/:userId/portfolio error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ========= PATCH /:userId/rate ========= */
/* Admin : ajuste le taux de commission individuel d'un commercial. */
router.patch("/:userId/rate", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const userId = Number(req.params.userId) || 0;
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    const rate = Number(req.body?.commission_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ error: "commission_rate doit être entre 0 et 1" });
    }

    const pool = getPool();
    const [r] = await pool.query(
      `UPDATE commercial_profiles SET commission_rate = ? WHERE user_id = ?`,
      [rate, userId]
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "Profil commercial introuvable" });
    }

    res.json({ ok: true, commission_rate: rate });
  } catch (e) {
    console.error("PATCH /api/commercial-profiles/:userId/rate error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:userId/settle ========= */
/* Admin : confirme le versement en une fois de toute la commission due
   PAR DUUMINI à ce commercial (pourcentage de ses ventes, comme pour un
   affilié — direction inverse de livreurProfiles.js où c'est le livreur
   qui doit une commission à DUUMINI sur les courses encaissées en cash ;
   même mécanique de flag PENDING -> PAID, sens différent). */
router.patch("/:userId/settle", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const userId = Number(req.params.userId) || 0;
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    const pool = getPool();

    const [r] = await pool.query(
      `UPDATE orders
          SET commercial_commission_status = 'PAID'
        WHERE commercial_id = ? AND commercial_commission_status = 'PENDING'`,
      [userId]
    );

    res.json({ ok: true, settled_orders: r.affectedRows });
  } catch (e) {
    console.error("PATCH /api/commercial-profiles/:userId/settle error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
