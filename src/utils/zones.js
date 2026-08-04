// src/utils/zones.js
// Zones de service (villes) pour le dispatch des courses livreur, pilotées
// par la table `service_zones` — même patron que `country.js`/`country_config`.
// Ajouter une ville = une ligne dans `service_zones`, aucune modification de
// code ici.

const { haversineKm } = require("./geo");

let _rows = null;
let _loaded = false;

/**
 * Charge et met en cache (mémoire process) la liste des zones actives
 * depuis `service_zones`. Même pattern que getCountryConfigCached.
 */
async function getServiceZonesCached(pool) {
  if (_loaded) return _rows;
  const [rows] = await pool.query(
    `SELECT code, country_code, city_label, center_lat, center_lng, radius_km, dispatch_radius_km
       FROM service_zones
      WHERE is_active = 1
      ORDER BY sort_order ASC`
  );
  _rows = rows;
  _loaded = true;
  return _rows;
}

/** À appeler après une modification de `service_zones` pour forcer un rechargement. */
function refreshServiceZonesCache() {
  _rows = null;
  _loaded = false;
}

/**
 * Retourne la zone de service active qui couvre le point (lat, lng), ou
 * `null` si aucune zone active ne le couvre.
 */
async function findZoneForPoint(pool, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const zones = await getServiceZonesCached(pool);
  for (const zone of zones) {
    const distanceKm = haversineKm(Number(zone.center_lat), Number(zone.center_lng), lat, lng);
    if (distanceKm <= Number(zone.radius_km)) return zone;
  }
  return null;
}

module.exports = {
  getServiceZonesCached,
  refreshServiceZonesCache,
  findZoneForPoint,
};
