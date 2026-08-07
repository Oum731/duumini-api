// src/routes/livreurProfiles.js
// Profils livreur : vérification d'identité (candidature → passage
// physique à l'agence → validation admin) et solde de commission dû à
// DUUMINI. Séparé de courierTrips.js car c'est une ressource distincte
// (identité/statut du livreur, pas les courses elles-mêmes).

const { Router } = require("express");

const { getPool } = require("../lib/db");
const { authRequired, requireRole, requireCapability, isLivreur } = require("../middlewares/auth");
const { findZoneForPoint } = require("../utils/zones");

const router = Router();

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/* ========= GET /me ========= */
/* Le livreur connecté consulte son propre statut + solde dû. */
router.get("/me", authRequired, requireCapability(isLivreur, "LIVREUR"), async (req, res) => {
  try {
    const pool = getPool();

    const [[profile]] = await pool.query(
      `SELECT country_code, city, verification_status, is_blocked, is_available
         FROM livreur_profiles WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!profile) {
      return res.status(404).json({ error: "Profil livreur introuvable" });
    }

    const [[{ due }]] = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS due
         FROM courier_trips
        WHERE livreur_user_id = ? AND status = 'DELIVERED' AND commission_status = 'PENDING'`,
      [req.user.id]
    );

    res.json({
      ...profile,
      pending_commission: Number(due),
    });
  } catch (e) {
    console.error("GET /api/livreur-profiles/me error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET / ========= */
/* Admin : liste des profils livreurs (identité, statut, solde). */
router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT
         lp.user_id, lp.country_code, lp.city, lp.vehicle_type,
         lp.id_document_url, lp.id_document_type, lp.photo_url,
         lp.verification_status, lp.is_blocked, lp.created_at,
         u.phone, u.first_name,
         COALESCE((
           SELECT SUM(ct.commission_amount)
             FROM courier_trips ct
            WHERE ct.livreur_user_id = lp.user_id
              AND ct.status = 'DELIVERED' AND ct.commission_status = 'PENDING'
         ), 0) AS pending_commission
       FROM livreur_profiles lp
       JOIN users u ON u.id = lp.user_id
       ORDER BY lp.created_at DESC`
    );

    res.json({ items: rows });
  } catch (e) {
    console.error("GET /api/livreur-profiles error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /me/position ========= */
/* Le livreur connecté diffuse sa position pendant qu'il est en ligne — sert
   au matching de proximité pour de nouvelles courses (basse fréquence,
   distinct du suivi live d'une course active sur courierTrips.js). */
router.patch("/me/position", authRequired, requireCapability(isLivreur, "LIVREUR"), async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidCoord(lat, lng)) {
      return res.status(400).json({ error: "Coordonnées invalides" });
    }

    const pool = getPool();
    const zone = await findZoneForPoint(pool, lat, lng);

    await pool.query(
      `UPDATE livreur_profiles
          SET last_lat = ?, last_lng = ?, last_location_at = NOW(), zone_code = ?
        WHERE user_id = ?`,
      [lat, lng, zone ? zone.code : null, req.user.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/livreur-profiles/me/position error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /me/availability ========= */
/* Le livreur connecté se déclare disponible/hors ligne pour de nouvelles
   courses (n'affecte pas les courses déjà acceptées). */
router.patch("/me/availability", authRequired, requireCapability(isLivreur, "LIVREUR"), async (req, res) => {
  try {
    const isAvailable = !!req.body?.is_available;

    const pool = getPool();
    await pool.query(`UPDATE livreur_profiles SET is_available = ? WHERE user_id = ?`, [
      isAvailable ? 1 : 0,
      req.user.id,
    ]);

    res.json({ ok: true, is_available: isAvailable });
  } catch (e) {
    console.error("PATCH /api/livreur-profiles/me/availability error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:userId/settle ========= */
/* Admin : règle en une fois tout le solde dû par ce livreur (équivalent en
   masse du toggle par course sur courierTrips.js), et le débloque. */
router.patch("/:userId/settle", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const userId = Number(req.params.userId) || 0;
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    const pool = getPool();

    const [r] = await pool.query(
      `UPDATE courier_trips
          SET commission_status = 'PAID', commission_paid_at = NOW()
        WHERE livreur_user_id = ? AND status = 'DELIVERED' AND commission_status = 'PENDING'`,
      [userId]
    );

    await pool.query(`UPDATE livreur_profiles SET is_blocked = 0 WHERE user_id = ?`, [userId]);

    res.json({ ok: true, settled_trips: r.affectedRows });
  } catch (e) {
    console.error("PATCH /api/livreur-profiles/:userId/settle error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:userId/validate ========= */
/* Admin : valide le profil après passage physique du livreur à l'agence. */
router.patch("/:userId/validate", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const userId = Number(req.params.userId) || 0;
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    const pool = getPool();
    const [r] = await pool.query(
      `UPDATE livreur_profiles SET verification_status = 'VALIDATED' WHERE user_id = ?`,
      [userId]
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "Profil livreur introuvable" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/livreur-profiles/:userId/validate error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
