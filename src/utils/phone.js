// src/utils/phone.js
const { parsePhoneNumberFromString, isValidPhoneNumber } = require("libphonenumber-js");

// Regex E.164 simplifiée, gardée en secours si libphonenumber-js échoue.
const RE_PHONE_INTL = /^\+[1-9]\d{7,14}$/;

// Marques Unicode invisibles (RTL/LTR) vues dans des numéros copiés-collés.
const BIDI_MARKS = /[‎‏‪-‮]/g;

/**
 * Normalisation légère : retire espaces/tirets/points/marques invisibles,
 * transforme un "00" de tête en "+". Ne devine rien d'autre.
 */
function normalizePhoneInput(raw) {
  let v = String(raw || "").trim();

  v = v.replace(BIDI_MARKS, "");
  v = v.replace(/[\s\-.]+/g, "");

  if (v.startsWith("00")) {
    v = "+" + v.slice(2);
  }

  return v;
}

/**
 * Forme canonique définitive (E.164 compact, ex: "+212707888487").
 * Retourne null si le numéro ne peut pas être validé.
 *
 * `defaultCountry` (indicatif ISO, ex: "MA"/"CI") sert uniquement pour un
 * numéro local sans indicatif (ex: "0707888487") — à fournir quand le pays
 * réel est connu par le contexte (boutique, commande...) pour éviter de
 * forcer le Maroc par défaut sur un numéro ivoirien.
 */
function normalizePhone(raw, defaultCountry) {
  defaultCountry = defaultCountry || "MA";
  const cleaned = normalizePhoneInput(raw);
  if (!cleaned) return null;

  if (cleaned.startsWith("+")) {
    try {
      const parsed = parsePhoneNumberFromString(cleaned);
      if (parsed && parsed.isValid()) return parsed.number;
    } catch {
      // ignore
    }
    return RE_PHONE_INTL.test(cleaned) ? cleaned : null;
  }

  if (/^0\d{6,}$/.test(cleaned)) {
    try {
      const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
      if (parsed && parsed.isValid()) return parsed.number;
    } catch {
      // ignore
    }
  }

  try {
    const parsed = parsePhoneNumberFromString("+" + cleaned);
    if (parsed && parsed.isValid()) return parsed.number;
  } catch {
    // ignore
  }

  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (parsed && parsed.isValid()) return parsed.number;
  } catch {
    // ignore
  }

  return null;
}

/** Format international "groupé" pour l'affichage (ex: "+212 707 88 84 87"). */
function formatPhoneDisplay(raw) {
  if (!raw) return "";
  const cleaned = normalizePhoneInput(String(raw));
  if (!cleaned) return "";

  try {
    const parsed = parsePhoneNumberFromString(cleaned);
    if (parsed && parsed.isValid()) return parsed.formatInternational();
  } catch {
    // ignore
  }

  return cleaned;
}

function isValidPhoneIntl(raw) {
  const v = normalizePhoneInput(raw);
  if (!v) return false;

  try {
    if (isValidPhoneNumber(v)) return true;
  } catch {
    // ignore
  }

  return RE_PHONE_INTL.test(v);
}

module.exports = {
  normalizePhoneInput,
  normalizePhone,
  // Alias compatible avec les anciennes implémentations locales `normPhone(p)`.
  normPhone: normalizePhone,
  formatPhoneDisplay,
  isValidPhoneIntl,
  RE_PHONE_INTL,
};
