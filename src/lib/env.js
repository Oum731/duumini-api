function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function required(nameArr) {
  const val = Array.isArray(nameArr) ? pick(...nameArr) : process.env[nameArr];
  if (!val) {
    throw new Error(
      `Missing env: ${Array.isArray(nameArr) ? nameArr.join("/") : nameArr}`
    );
  }
  return val;
}

/**
 * ✅ Rend une variable obligatoire seulement si condition=true.
 * Exemple:
 *  OPENAI_API_KEY: requireIf(isAiEnabled(), "OPENAI_API_KEY", "")
 */
function requireIf(condition, nameArr, fallback = "") {
  if (!condition) {
    // pas obligatoire → retourne fallback
    const v = Array.isArray(nameArr) ? pick(...nameArr) : process.env[nameArr];
    return v ?? fallback;
  }
  // obligatoire → required()
  return required(nameArr);
}

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

function isAiOn(mode) {
  const m = upper(mode);
  return m !== "OFF";
}

function isMetaAutoAllowed(mode) {
  // AUTO permet activation, SAFE force pause côté route
  const m = upper(mode);
  return m === "AUTO" || m === "SAFE";
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || process.env.APP_PORT || 4000),
  CORS_ORIGINS: pick("CORS_ORIGINS", "CORS_ORIGIN") || "*",

  /* =========================
   * DB (toujours obligatoire)
   * =======================*/
  DB_HOST: required(["DB_HOST", "MYSQL_HOST"]),
  DB_PORT: Number(pick("DB_PORT", "MYSQL_PORT") || 3306),
  DB_USER: required(["DB_USER", "MYSQL_USER"]),
  DB_PASSWORD: required(["DB_PASSWORD", "DB_PASS", "MYSQL_PASSWORD"]),
  DB_NAME: required(["DB_NAME", "MYSQL_DB"]),
  MYSQL_SSL: String(pick("MYSQL_SSL") || "false").toLowerCase() === "true",

  /* =========================
   * JWT (toujours obligatoire)
   * =======================*/
  JWT_ACCESS_SECRET: required([
    "JWT_ACCESS_SECRET",
    "JWT_SECRET",
    "JWT_SECRET_KEY",
    "SECRET_KEY",
  ]),
  JWT_REFRESH_SECRET: required([
    "JWT_REFRESH_SECRET",
    "JWT_SECRET_KEY",
    "JWT_SECRET",
    "SECRET_KEY",
  ]),
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || "15m",
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL || "30d",

  /* =========================
   * CLOUDINARY (optionnel)
   * =======================*/
  CLOUDINARY_CLOUD_NAME: pick("CLOUDINARY_CLOUD_NAME") || "",
  CLOUDINARY_API_KEY: pick("CLOUDINARY_API_KEY") || "",
  CLOUDINARY_API_SECRET: pick("CLOUDINARY_API_SECRET") || "",

  /* =========================
   * TWILIO (optionnel)
   * =======================*/
  TWILIO_ACCOUNT_SID: pick("TWILIO_ACCOUNT_SID") || "",
  TWILIO_AUTH_TOKEN: pick("TWILIO_AUTH_TOKEN") || "",
  TWILIO_API_KEY_SID: pick("TWILIO_API_KEY_SID") || "",
  TWILIO_API_KEY_SECRET: pick("TWILIO_API_KEY_SECRET") || "",
  TWILIO_VERIFY_SID: pick("TWILIO_VERIFY_SID") || "",

  /* =========================
   * PUSHY
   * =======================*/
  PUSHY_API_KEY: pick("PUSHY_API_KEY") || "",

  /* =========================
   * CATALOGUE B2B (optionnel) — code d'accès partagé aux
   * fournisseurs/partenaires pour /api/products/b2b-catalogue.
   * Pas une vraie authentification, juste un frein simple contre la
   * découverte accidentelle/indexation (décision produit validée).
   * =======================*/
  CATALOG_B2B_ACCESS_CODE: pick("CATALOG_B2B_ACCESS_CODE") || "",

  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL || "http://localhost:4000",

  LISTENERS_ENABLED:
    String(process.env.LISTENERS_ENABLED || "true").toLowerCase() === "true",
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || 10000),

  /* =========================
   * DUUMINI AI (mode/branding)
   * =======================*/
  DUUMINI_AI_MODE: pick("DUUMINI_AI_MODE") || "SAFE", // OFF | SAFE | AUTO
  DUUMINI_AI_MAIN_URL: pick("DUUMINI_AI_MAIN_URL") || "https://duumini.com",
  DUUMINI_AI_BRAND_NAME: pick("DUUMINI_AI_BRAND_NAME") || "Duumini",

  /* =========================
   * META ADS (optionnel sauf si AI ON)
   * =======================*/
  META_APP_ID: pick("META_APP_ID") || "",
  META_BUSINESS_ID: pick("META_BUSINESS_ID") || "",
  META_PIXEL_ID: pick("META_PIXEL_ID") || "",

  // ✅ requis seulement si AI ads meta est utilisé (mode != OFF)
  META_AD_ACCOUNT_ID: requireIf(isAiOn(pick("DUUMINI_AI_MODE") || "SAFE"), "META_AD_ACCOUNT_ID", ""),
  META_AD_ACCESS_TOKEN: requireIf(isAiOn(pick("DUUMINI_AI_MODE") || "SAFE"), "META_AD_ACCESS_TOKEN", ""),

  // ✅ utiles pour éviter de retaper dans l’admin
  META_PAGE_ID: pick("META_PAGE_ID") || "",
  META_DEFAULT_ADSET_ID: pick("META_DEFAULT_ADSET_ID") || "",

  /* =========================
   * OPENAI (requis seulement si AI ON)
   * =======================*/
  OPENAI_API_KEY: requireIf(isAiOn(pick("DUUMINI_AI_MODE") || "SAFE"), "OPENAI_API_KEY", ""),
  OPENAI_BASE_URL: pick("OPENAI_BASE_URL") || "",

  // options (si non fournis, duuminiAgent a ses defaults)
  OPENAI_MODEL: pick("OPENAI_MODEL") || "",
  OPENAI_TEMPERATURE: pick("OPENAI_TEMPERATURE") || "",
  OPENAI_MAX_TOKENS: pick("OPENAI_MAX_TOKENS") || "",
};

/* =========================
 * ✅ Logs “OK / missing” (optionnel)
 * =======================*/
function mask(v) {
  return v ? "OK" : "missing";
}

function logEnv() {
  // à appeler dans server.js si tu veux
  console.log("[ENV] NODE_ENV =", env.NODE_ENV);
  console.log("[ENV] PORT =", env.PORT);
  console.log("[ENV] CORS_ORIGINS =", env.CORS_ORIGINS);
  console.log("[ENV] DUUMINI_AI_MODE =", env.DUUMINI_AI_MODE);

  console.log("[ENV] OPENAI_API_KEY =", mask(env.OPENAI_API_KEY));
  console.log("[ENV] OPENAI_MODEL =", env.OPENAI_MODEL || "default");

  console.log("[ENV] META_AD_ACCOUNT_ID =", mask(env.META_AD_ACCOUNT_ID));
  console.log("[ENV] META_AD_ACCESS_TOKEN =", mask(env.META_AD_ACCESS_TOKEN));
  console.log("[ENV] META_PAGE_ID =", mask(env.META_PAGE_ID));
  console.log("[ENV] META_DEFAULT_ADSET_ID =", mask(env.META_DEFAULT_ADSET_ID));
  console.log("[ENV] CATALOG_B2B_ACCESS_CODE =", mask(env.CATALOG_B2B_ACCESS_CODE));
}

module.exports = { env, pick, required, requireIf, logEnv };
