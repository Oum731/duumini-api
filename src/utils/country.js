// src/utils/country.js
// Support pays (ISO 3166-1 alpha-2), piloté par la table `country_config`
// (Phase 2 de la refonte Duumini 2.0 — voir
// docs/duumini-2.0/09-expansion-panafricaine.md dans duumini-web).
// Ajouter un pays = une ligne dans `country_config`, plus de modification
// de code ici.

let _rows = null;
let _loaded = false;

/**
 * Charge et met en cache (mémoire process) la liste des pays depuis
 * `country_config`. Même pattern que getCitiesColCached/
 * getOrdersDiscountColsCached dans routes/products.js et routes/orders.js.
 */
async function getCountryConfigCached(pool) {
  if (_loaded) return _rows;
  const [rows] = await pool.query(
    `SELECT code, label, currency, flag_emoji, description, is_active, sort_order
       FROM country_config
      ORDER BY sort_order ASC`
  );
  _rows = rows;
  _loaded = true;
  return _rows;
}

/** À appeler après une modification de `country_config` pour forcer un rechargement. */
function refreshCountryConfigCache() {
  _rows = null;
  _loaded = false;
}

/**
 * Normalise une entrée utilisateur (code ISO ou texte libre type "Maroc" /
 * "Côte d'Ivoire") vers un code ISO alpha-2 connu de `country_config`.
 * Retourne `fallback` (par défaut 'MA') si rien d'exploitable n'est fourni.
 */
async function normalizeCountryCode(pool, input, fallback = "MA") {
  const raw = String(input || "").trim();
  if (!raw) return fallback;

  const rows = await getCountryConfigCached(pool);
  const codes = rows.map((r) => r.code);

  const upper = raw.toUpperCase();
  if (codes.includes(upper)) return upper;

  const lower = raw.toLowerCase();
  const byLabel = rows.find((r) => lower.includes(String(r.label || "").toLowerCase()));
  if (byLabel) return byLabel.code;

  return fallback;
}

async function countryLabel(pool, code) {
  const rows = await getCountryConfigCached(pool);
  const row = rows.find((r) => r.code === String(code || "").toUpperCase());
  return row?.label || code || "";
}

module.exports = {
  getCountryConfigCached,
  refreshCountryConfigCache,
  normalizeCountryCode,
  countryLabel,
};
