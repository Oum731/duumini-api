// src/lib/metaAds.js
let fetchFn = global.fetch;
if (!fetchFn) fetchFn = require("node-fetch");

const { env } = require("./env");

const META_GRAPH = "https://graph.facebook.com/v21.0";
const AD_ACCOUNT_ID = env.META_AD_ACCOUNT_ID; // "act_123..."
const META_TOKEN = env.META_AD_ACCESS_TOKEN;

if (!AD_ACCOUNT_ID || !META_TOKEN) {
  console.warn("[META ADS] META_AD_ACCOUNT_ID ou META_AD_ACCESS_TOKEN manquant");
}

function normalizeCta(cta) {
  const s = String(cta || "SHOP_NOW").trim().toUpperCase();
  const map = {
    "COMMANDER MAINTENANT": "SHOP_NOW",
    "ACHETER": "SHOP_NOW",
    "ACHETER MAINTENANT": "SHOP_NOW",
    "EN SAVOIR PLUS": "LEARN_MORE",
    "CONTACTER": "CONTACT_US",
    "MESSAGE": "MESSAGE_PAGE",
  };
  return map[s] || s.replace(/\s+/g, "_");
}

async function metaPost(endpoint, payload) {
  if (!AD_ACCOUNT_ID || !META_TOKEN) {
    throw new Error("meta_config_missing: META_AD_ACCOUNT_ID / META_AD_ACCESS_TOKEN");
  }

  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${META_TOKEN}` },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.error_user_msg || "Meta API error";
    const code = data?.error?.code;
    const subcode = data?.error?.error_subcode;
    const type = data?.error?.type;
    const err = new Error(msg);
    err.meta = { code, subcode, type, raw: data };
    throw err;
  }
  return data;
}

/* =========================
 * NEW: Campaign + Adset
 * =======================*/

// Meta attend souvent des montants en "minor units" (ex: 100.00 -> 10000)
// Ici on considère MAD et on fait *100 par défaut.
function toMinorUnits(amount) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

async function createCampaign({ name, objective, status = "PAUSED" }) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/campaigns`;

  const obj = String(objective || env.META_CAMPAIGN_OBJECTIVE || "OUTCOME_SALES").trim();
  const payload = {
    name: name || `Duumini Campaign - ${new Date().toISOString()}`,
    objective: obj,
    status: String(status || "PAUSED").toUpperCase(),
    special_ad_categories: [], // important: requis même vide
  };

  return metaPost(endpoint, payload); // { id }
}

function buildTargeting({ country = "MA", cities = ["Casablanca", "Marrakech"], age_min = 18, age_max = 45, interests = [] }) {
  // Version simple (safe). Si tu veux des intérêts "réels", il faut des interest IDs via Meta Marketing API.
  // On garde donc un targeting géo + âge (stable).
  const t = {
    age_min: Number(age_min || 18),
    age_max: Number(age_max || 65),
    geo_locations: {
      countries: [String(country || "MA")],
      // "cities" en API c'est plus complexe (lat/radius). On reste simple: country.
    },
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: ["feed", "marketplace", "story", "reels"],
    instagram_positions: ["stream", "story", "reels"],
  };

  // Si tu veux cibler Casablanca/Marrakech précisément, on le fera ensuite avec custom locations (lat/radius).
  return t;
}

async function createAdSet({
  name,
  campaignId,
  dailyBudgetMad,
  optimizationGoal,
  billingEvent,
  pixelId,
  conversionEvent,
  targeting,
  status = "PAUSED",
}) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/adsets`;

  if (!campaignId) throw new Error("createAdSet: campaignId requis");

  const daily_budget = toMinorUnits(dailyBudgetMad || 80);
  if (!daily_budget) throw new Error("createAdSet: dailyBudget invalide");

  const px = String(pixelId || env.META_PIXEL_ID || "").trim();
  const evt = String(conversionEvent || env.META_CONVERSION_EVENT || "PURCHASE").trim().toUpperCase();

  // Pour ventes/conversions, Meta recommande OFFSITE_CONVERSIONS + IMPRESSIONS
  const payload = {
    name: name || `Duumini AdSet - ${new Date().toISOString()}`,
    campaign_id: String(campaignId),
    daily_budget: String(daily_budget),
    billing_event: String(billingEvent || "IMPRESSIONS"),
    optimization_goal: String(optimizationGoal || "OFFSITE_CONVERSIONS"),
    status: String(status || "PAUSED").toUpperCase(),
    targeting: targeting || buildTargeting({}),
  };

  if (px) {
    payload.promoted_object = {
      pixel_id: px,
      custom_event_type: evt,
    };
  }

  return metaPost(endpoint, payload); // { id }
}

/* =========================
 * Creative + Ad (existing)
 * =======================*/

async function createAdCreative({ name, pageId, primaryText, headline, description, url, picture, callToAction }) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/adcreatives`;
  const safeUrl = String(url || "").trim();
  if (!pageId || !safeUrl) throw new Error("createAdCreative: pageId et url requis");

  const linkData = {
    message: String(primaryText || "").trim(),
    link: safeUrl,
    caption: safeUrl.replace(/^https?:\/\//, ""),
    name: String(headline || "").trim(),
    description: String(description || "").trim(),
    call_to_action: {
      type: normalizeCta(callToAction),
      value: { link: safeUrl },
    },
  };

  const safePicture = String(picture || "").trim();
  if (safePicture) linkData.picture = safePicture;

  const payload = {
    name: name || `Duumini Creative - ${new Date().toISOString()}`,
    object_story_spec: {
      page_id: String(pageId),
      link_data: linkData,
    },
  };

  return metaPost(endpoint, payload); // { id }
}

async function createAd({ name, adsetId, creativeId, status = "PAUSED" }) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/ads`;
  if (!adsetId || !creativeId) throw new Error("createAd: adsetId et creativeId requis");

  const payload = {
    name: name || `Duumini Ad - ${new Date().toISOString()}`,
    adset_id: String(adsetId),
    creative: { creative_id: String(creativeId) },
    status: String(status || "PAUSED").toUpperCase(),
  };

  return metaPost(endpoint, payload); // { id }
}

module.exports = {
  createCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  buildTargeting,
};
