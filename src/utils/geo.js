// src/utils/geo.js
// Distance à vol d'oiseau (formule de Haversine) — aucune dépendance
// externe, aucune clé API. Sert de base au calcul du prix des courses
// livreur (cf. src/routes/courierTrips.js) : approximation volontaire,
// pas la distance routière réelle.

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Distance en km entre deux points (lat/lng en degrés décimaux). */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

module.exports = { haversineKm };
