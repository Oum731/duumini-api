// src/routes/courierTrips.js
// Service de courses indépendantes : réservation d'un livreur pour
// transporter un colis d'un point A à un point B, sans lien avec les
// commandes produits. DUUMINI prélève une commission sur chaque course.
//
// Tarification : distance à vol d'oiseau (Haversine) calculée et validée
// côté serveur — jamais confiance en une distance/un prix envoyé par le
// client. Pas de calcul de distance routière réelle (v1).

const { Router } = require("express");

const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { normalizeCountryCode } = require("../utils/country");
const { normPhone } = require("../utils/phone");
const { haversineKm } = require("../utils/geo");
const { findZoneForPoint } = require("../utils/zones");
const { emitToUsers } = require("../ws");
const { notifyUser } = require("../services/notify");

const router = Router();

const COMMISSION_RATE = 7; // % — dans la fourchette 5-8% demandée
const PAYMENT_METHODS = ["CASH", "BMCE", "GAZHALA"];
const TRIP_TYPES = ["PICKUP", "SHOPPING"];

// Tarification par tranches (type Yango Livraison) : le prix dans la
// fourchette suit la distance, jamais une saisie du client. Une course
// "SHOPPING" (le livreur doit chercher/acheter le produit) pousse le prix
// vers le haut de la même fourchette plutôt que d'utiliser une fourchette
// séparée. Constantes ajustables ici uniquement.
const MAX_DISTANCE_KM = 15; // au-delà, prix plafonné au haut de la fourchette
const SHOPPING_BOOST = 0.35; // part de la fourchette ajoutée pour une course SHOPPING
const PRICE_RANGES = {
  NORMAL: { low: 10, high: 30 }, // colis ≤ 30kg
  HEAVY: { low: 50, high: 100 }, // colis > 30kg
};

function computePrice(distanceKm, isHeavy, tripType) {
  const range = isHeavy ? PRICE_RANGES.HEAVY : PRICE_RANGES.NORMAL;
  const ratio = Math.min(
    1,
    distanceKm / MAX_DISTANCE_KM + (tripType === "SHOPPING" ? SHOPPING_BOOST : 0)
  );
  const price = range.low + (range.high - range.low) * ratio;
  return Math.round(price * 100) / 100;
}

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

const LIVREUR_POSITION_TTL_MINUTES = 15; // au-delà, position jugée périmée (livreur considéré hors ligne)

async function queueLivreurNotifications(pool, trip, zone) {
  const [rows] = await pool.query(
    `SELECT user_id, last_lat, last_lng FROM livreur_profiles
      WHERE is_available = 1 AND verification_status = 'VALIDATED' AND is_blocked = 0
        AND country_code = ? AND last_lat IS NOT NULL AND last_lng IS NOT NULL
        AND last_location_at >= NOW() - INTERVAL ? MINUTE`,
    [trip.country_code, LIVREUR_POSITION_TTL_MINUTES]
  );
  if (!rows.length) return;

  const dispatchRadiusKm = zone ? Number(zone.dispatch_radius_km) : 6;
  const nearby = rows
    .map((r) => ({
      user_id: r.user_id,
      distanceKm: haversineKm(trip.pickup_lat, trip.pickup_lng, Number(r.last_lat), Number(r.last_lng)),
    }))
    .filter((r) => r.distanceKm <= dispatchRadiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  if (!nearby.length) return;

  const payload = JSON.stringify({
    trip_id: trip.id,
    pickup_address: trip.pickup_address,
    dropoff_address: trip.dropoff_address,
    distance_km: trip.distance_km,
    price: trip.price,
  });

  const values = nearby.map((r) => [r.user_id, "COURIER_TRIP_REQUESTED", payload, "queued"]);
  await pool.query(
    `INSERT INTO notification_queue (user_id, type, payload, status) VALUES ?`,
    [values]
  );
}

const STATUS_LABEL_FR = {
  ACCEPTED: "acceptée",
  IN_PROGRESS: "en cours",
  DELIVERED: "livrée",
  CANCELLED: "annulée",
};

/* Diffuse un changement de statut au demandeur : event WS dédié (mise à
   jour instantanée si la page de suivi est ouverte) + notify générique
   (toast/push, même s'il ne l'a pas ouverte). */
async function notifyTripStatus(requesterUserId, tripId, status) {
  emitToUsers([requesterUserId], "courier_trip_status", { trip_id: tripId, status });
  try {
    await notifyUser(requesterUserId, "COURIER_TRIP_STATUS", {
      trip_id: tripId,
      status,
      title: "Votre course DUUMINI",
      body: `Votre course est désormais ${STATUS_LABEL_FR[status] || status}.`,
    });
  } catch (e) {
    console.error("courierTrips: notifyTripStatus failed:", e?.message || e);
  }
}

/* ========= POST / ========= */
/* Réservation d'une course — tout utilisateur connecté. */
router.post("/", authRequired, async (req, res) => {
  try {
    const {
      pickup_address,
      pickup_lat,
      pickup_lng,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
      package_description,
      payment_method,
      country_code,
      requester_phone,
      requester_name,
      trip_type,
      is_heavy_package,
    } = req.body || {};

    const pLat = Number(pickup_lat);
    const pLng = Number(pickup_lng);
    const dLat = Number(dropoff_lat);
    const dLng = Number(dropoff_lng);

    if (!isValidCoord(pLat, pLng) || !isValidCoord(dLat, dLng)) {
      return res.status(400).json({ error: "Coordonnées de départ/arrivée invalides" });
    }

    const cleanPickupAddress = String(pickup_address || "").trim();
    const cleanDropoffAddress = String(dropoff_address || "").trim();
    if (!cleanPickupAddress || !cleanDropoffAddress) {
      return res.status(400).json({ error: "Adresses de départ et d'arrivée requises" });
    }

    const cleanPhone = normPhone(requester_phone);
    if (!cleanPhone) {
      return res.status(400).json({ error: "Numéro de téléphone invalide" });
    }

    const method = String(payment_method || "CASH").toUpperCase();
    if (!PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({
        error: `payment_method invalide (attendu: ${PAYMENT_METHODS.join(", ")})`,
      });
    }

    const tripType = String(trip_type || "PICKUP").toUpperCase();
    if (!TRIP_TYPES.includes(tripType)) {
      return res.status(400).json({
        error: `trip_type invalide (attendu: ${TRIP_TYPES.join(", ")})`,
      });
    }
    const isHeavy = !!is_heavy_package;

    const pool = getPool();
    const finalCountryCode = await normalizeCountryCode(pool, country_code, "MA");

    const zone = await findZoneForPoint(pool, pLat, pLng);
    if (!zone) {
      return res.status(422).json({
        error: "Ce service n'est pas encore disponible dans votre secteur.",
      });
    }

    const distanceKm = Math.round(haversineKm(pLat, pLng, dLat, dLng) * 100) / 100;
    const price = computePrice(distanceKm, isHeavy, tripType);
    const commissionAmount = Math.round(((price * COMMISSION_RATE) / 100) * 100) / 100;

    const [r] = await pool.query(
      `INSERT INTO courier_trips
         (requester_user_id, country_code, zone_code, pickup_address, pickup_lat, pickup_lng,
          dropoff_address, dropoff_lat, dropoff_lng, distance_km, package_description,
          trip_type, is_heavy_package, price, commission_rate, commission_amount, payment_method,
          requester_phone, requester_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        finalCountryCode,
        zone.code,
        cleanPickupAddress,
        pLat,
        pLng,
        cleanDropoffAddress,
        dLat,
        dLng,
        distanceKm,
        package_description ? String(package_description).trim() : null,
        tripType,
        isHeavy ? 1 : 0,
        price,
        COMMISSION_RATE,
        commissionAmount,
        method,
        cleanPhone,
        requester_name ? String(requester_name).trim() : null,
      ]
    );

    const trip = {
      id: r.insertId,
      country_code: finalCountryCode,
      pickup_address: cleanPickupAddress,
      pickup_lat: pLat,
      pickup_lng: pLng,
      dropoff_address: cleanDropoffAddress,
      distance_km: distanceKm,
      price,
    };

    try {
      await queueLivreurNotifications(pool, trip, zone);
    } catch (e) {
      console.error("courierTrips: notification queue failed:", e?.message || e);
    }

    res.status(201).json({
      id: r.insertId,
      distance_km: distanceKm,
      price,
      commission_amount: commissionAmount,
      status: "REQUESTED",
    });
  } catch (e) {
    console.error("POST /api/courier-trips error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /available ========= */
/* Courses en attente d'un livreur, dans le pays du livreur connecté. */
router.get("/available", authRequired, requireRole("LIVREUR"), async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset, limit } = getPagination(req);

    const [[profile]] = await pool.query(
      `SELECT country_code FROM livreur_profiles WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!profile) {
      return res.status(404).json({ error: "Profil livreur introuvable" });
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM courier_trips WHERE status = 'REQUESTED' AND country_code = ?`,
      [profile.country_code]
    );

    const [rows] = await pool.query(
      `SELECT * FROM courier_trips
        WHERE status = 'REQUESTED' AND country_code = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?`,
      [profile.country_code, limit, offset]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    console.error("GET /api/courier-trips/available error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /mine ========= */
/* Selon le rôle : demandeur voit ses courses, livreur voit les siennes. */
router.get("/mine", authRequired, async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset, limit } = getPagination(req);
    const role = String(req.user?.role || "").toUpperCase();
    const col = role === "LIVREUR" ? "livreur_user_id" : "requester_user_id";

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM courier_trips WHERE ${col} = ?`,
      [req.user.id]
    );

    const [rows] = await pool.query(
      `SELECT * FROM courier_trips WHERE ${col} = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    console.error("GET /api/courier-trips/mine error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /:id ========= */
/* Détail d'une course — demandeur, livreur assigné, ou admin. Alimente la
   page de suivi client (position live du livreur incluse). */
router.get("/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();
    const [[trip]] = await pool.query(`SELECT * FROM courier_trips WHERE id = ? LIMIT 1`, [id]);
    if (!trip) return res.status(404).json({ error: "Course introuvable" });

    const isAdmin = String(req.user?.role || "").toUpperCase() === "ADMIN";
    const isRequester = trip.requester_user_id === req.user.id;
    const isAssignedLivreur = trip.livreur_user_id === req.user.id;
    if (!isAdmin && !isRequester && !isAssignedLivreur) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    res.json(trip);
  } catch (e) {
    console.error("GET /api/courier-trips/:id error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:id/accept ========= */
/* Un livreur accepte une course ouverte — atomique pour éviter la double-acceptation. */
router.patch("/:id/accept", authRequired, requireRole("LIVREUR"), async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();

    const [[profile]] = await pool.query(
      `SELECT verification_status, is_blocked FROM livreur_profiles WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!profile || profile.verification_status !== "VALIDATED") {
      return res.status(403).json({
        error: "Votre compte n'est pas encore validé. Rendez-vous à l'agence DUUMINI avec vos documents originaux.",
      });
    }
    if (profile.is_blocked) {
      return res.status(403).json({
        error: "Votre compte est bloqué (commission impayée). Réglez votre solde auprès de DUUMINI.",
      });
    }

    const [r] = await pool.query(
      `UPDATE courier_trips
          SET status = 'ACCEPTED', livreur_user_id = ?, accepted_at = NOW()
        WHERE id = ? AND status = 'REQUESTED'`,
      [req.user.id, id]
    );

    if (!r.affectedRows) {
      return res.status(409).json({ error: "Cette course n'est plus disponible" });
    }

    const [[trip]] = await pool.query(
      `SELECT requester_user_id FROM courier_trips WHERE id = ? LIMIT 1`,
      [id]
    );
    if (trip?.requester_user_id) {
      await notifyTripStatus(trip.requester_user_id, id, "ACCEPTED");
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/courier-trips/:id/accept error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:id/status ========= */
/* Progression ACCEPTED -> IN_PROGRESS -> DELIVERED, par le livreur assigné. */
router.patch("/:id/status", authRequired, requireRole("LIVREUR"), async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    const status = String(req.body?.status || "").toUpperCase();
    const TRANSITIONS = {
      ACCEPTED: "IN_PROGRESS",
      IN_PROGRESS: "DELIVERED",
    };
    const timestampCol = { DELIVERED: "delivered_at" };

    if (!id) return res.status(400).json({ error: "Invalid id" });
    if (!["IN_PROGRESS", "DELIVERED"].includes(status)) {
      return res.status(400).json({ error: "status invalide" });
    }

    const pool = getPool();
    const [[trip]] = await pool.query(
      `SELECT status, livreur_user_id, requester_user_id FROM courier_trips WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!trip) return res.status(404).json({ error: "Course introuvable" });
    if (trip.livreur_user_id !== req.user.id) {
      return res.status(403).json({ error: "Cette course ne vous est pas assignée" });
    }
    if (TRANSITIONS[trip.status] !== status) {
      return res.status(409).json({ error: `Transition invalide depuis ${trip.status}` });
    }

    const tsCol = timestampCol[status];
    const sql = tsCol
      ? `UPDATE courier_trips SET status = ?, ${tsCol} = NOW() WHERE id = ?`
      : `UPDATE courier_trips SET status = ? WHERE id = ?`;
    await pool.query(sql, [status, id]);

    await notifyTripStatus(trip.requester_user_id, id, status);

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/courier-trips/:id/status error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:id/cancel ========= */
/* Le demandeur (avant acceptation) ou un admin peut annuler. */
router.patch("/:id/cancel", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();
    const [[trip]] = await pool.query(
      `SELECT requester_user_id, status FROM courier_trips WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!trip) return res.status(404).json({ error: "Course introuvable" });

    const isAdmin = String(req.user?.role || "").toUpperCase() === "ADMIN";
    const isOwner = trip.requester_user_id === req.user.id;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Non autorisé" });
    }
    if (["DELIVERED", "CANCELLED"].includes(trip.status)) {
      return res.status(409).json({ error: "Cette course ne peut plus être annulée" });
    }

    await pool.query(
      `UPDATE courier_trips SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = ?`,
      [id]
    );

    await notifyTripStatus(trip.requester_user_id, id, "CANCELLED");

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/courier-trips/:id/cancel error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:id/position ========= */
/* Le livreur assigné diffuse sa position pendant une course active — carte
   de suivi client en direct. Fréquent (quelques secondes), donc uniquement
   l'event WS dédié, jamais de push (pas de notifyUser ici). */
router.patch("/:id/position", authRequired, requireRole("LIVREUR"), async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidCoord(lat, lng)) {
      return res.status(400).json({ error: "Coordonnées invalides" });
    }

    const pool = getPool();
    const [[trip]] = await pool.query(
      `SELECT status, livreur_user_id, requester_user_id FROM courier_trips WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!trip) return res.status(404).json({ error: "Course introuvable" });
    if (trip.livreur_user_id !== req.user.id) {
      return res.status(403).json({ error: "Cette course ne vous est pas assignée" });
    }
    if (!["ACCEPTED", "IN_PROGRESS"].includes(trip.status)) {
      return res.status(409).json({ error: "Cette course n'est pas active" });
    }

    await pool.query(
      `UPDATE courier_trips SET livreur_lat = ?, livreur_lng = ?, livreur_location_at = NOW() WHERE id = ?`,
      [lat, lng, id]
    );

    emitToUsers([trip.requester_user_id], "courier_trip_position", {
      trip_id: id,
      lat,
      lng,
      at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/courier-trips/:id/position error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ===== Admin ===== */

/* ========= GET / ========= */
router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset, limit } = getPagination(req);
    const { status, country_code } = req.query;

    const where = [];
    const params = [];
    if (status) {
      where.push("status = ?");
      params.push(String(status).toUpperCase());
    }
    if (country_code) {
      where.push("country_code = ?");
      params.push(String(country_code).toUpperCase());
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM courier_trips ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT * FROM courier_trips ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    console.error("GET /api/courier-trips error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /:id/commission-status ========= */
router.patch(
  "/:id/commission-status",
  authRequired,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const id = Number(req.params.id) || 0;
      const status = String(req.body?.commission_status || "").toUpperCase();
      if (!id) return res.status(400).json({ error: "Invalid id" });
      if (!["PENDING", "PAID"].includes(status)) {
        return res.status(400).json({ error: "commission_status invalide" });
      }

      const pool = getPool();
      const sql =
        status === "PAID"
          ? `UPDATE courier_trips SET commission_status = ?, commission_paid_at = NOW() WHERE id = ?`
          : `UPDATE courier_trips SET commission_status = ?, commission_paid_at = NULL WHERE id = ?`;
      const [r] = await pool.query(sql, [status, id]);

      if (!r.affectedRows) {
        return res.status(404).json({ error: "Course introuvable" });
      }

      // Déblocage automatique si le solde dû par ce livreur retombe à 0.
      if (status === "PAID") {
        const [[trip]] = await pool.query(
          `SELECT livreur_user_id FROM courier_trips WHERE id = ? LIMIT 1`,
          [id]
        );
        if (trip?.livreur_user_id) {
          const [[{ due }]] = await pool.query(
            `SELECT COALESCE(SUM(commission_amount), 0) AS due
               FROM courier_trips
              WHERE livreur_user_id = ? AND status = 'DELIVERED' AND commission_status = 'PENDING'`,
            [trip.livreur_user_id]
          );
          if (Number(due) === 0) {
            await pool.query(
              `UPDATE livreur_profiles SET is_blocked = 0 WHERE user_id = ?`,
              [trip.livreur_user_id]
            );
          }
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error("PATCH /api/courier-trips/:id/commission-status error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

module.exports = router;
