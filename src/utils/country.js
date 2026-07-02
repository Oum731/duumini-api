// src/utils/country.js
// Support pays (ISO 3166-1 alpha-2) posé en Phase 0 de la refonte Duumini 2.0
// (voir docs/duumini-2.0/09-expansion-panafricaine.md dans duumini-web).

const ALLOWED_COUNTRY_CODES = ["MA", "CI"];

const COUNTRY_LABELS = {
  MA: "Maroc",
  CI: "Côte d'Ivoire",
};

/**
 * Normalise une entrée utilisateur (code ISO ou texte libre type "Maroc" /
 * "Côte d'Ivoire") vers un code ISO alpha-2 supporté. Retourne `fallback`
 * (par défaut 'MA') si rien d'exploitable n'est fourni.
 */
function normalizeCountryCode(input, fallback = "MA") {
  const raw = String(input || "").trim();
  if (!raw) return fallback;

  const upper = raw.toUpperCase();
  if (ALLOWED_COUNTRY_CODES.includes(upper)) return upper;

  const lower = raw.toLowerCase();
  if (lower.includes("ivoire") || lower === "ci") return "CI";
  if (lower.includes("maroc") || lower.includes("morocco") || lower === "ma") return "MA";

  return fallback;
}

function countryLabel(code) {
  return COUNTRY_LABELS[String(code || "").toUpperCase()] || code || "";
}

module.exports = { ALLOWED_COUNTRY_CODES, COUNTRY_LABELS, normalizeCountryCode, countryLabel };
