let fetchFn = global.fetch;
if (!fetchFn) {
  // fallback si runtime ancien
  fetchFn = require("node-fetch");
}

const { env } = require("./env");

const META_GRAPH = "https://graph.facebook.com/v21.0";

const AD_ACCOUNT_ID = env.META_AD_ACCOUNT_ID; // ex: "act_123..."
const META_TOKEN = env.META_AD_ACCESS_TOKEN;

if (!AD_ACCOUNT_ID || !META_TOKEN) {
  console.warn("[META ADS] META_AD_ACCOUNT_ID ou META_AD_ACCESS_TOKEN manquant");
}

function normalizeCta(cta) {
  const s = String(cta || "SHOP_NOW").trim().toUpperCase();
  // convertit "Commander maintenant" → "SHOP_NOW" si user donne du français
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
    throw new Error(
      "meta_config_missing: META_AD_ACCOUNT_ID / META_AD_ACCESS_TOKEN"
    );
  }

  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${META_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.error?.error_user_msg ||
      "Meta API error";
    const code = data?.error?.code;
    const subcode = data?.error?.error_subcode;
    const type = data?.error?.type;
    const details = { code, subcode, type, raw: data };
    const err = new Error(msg);
    err.meta = details;
    throw err;
  }

  return data;
}

async function createAdCreative({
  name,
  pageId,
  primaryText,
  headline,
  description,
  url,
  callToAction,
}) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/adcreatives`;

  const safeUrl = String(url || "").trim();
  if (!pageId || !safeUrl) {
    throw new Error("createAdCreative: pageId et url requis");
  }

  const payload = {
    name: name || `Duumini Creative - ${new Date().toISOString()}`,
    object_story_spec: {
      page_id: String(pageId),
      link_data: {
        message: String(primaryText || "").trim(),
        link: safeUrl,
        caption: safeUrl.replace(/^https?:\/\//, ""),
        name: String(headline || "").trim(), // headline
        description: String(description || "").trim(),
        call_to_action: {
          type: normalizeCta(callToAction),
          value: { link: safeUrl },
        },
      },
    },
  };

  return metaPost(endpoint, payload); // { id: "..." }
}

async function createAd({ name, adsetId, creativeId, status = "PAUSED" }) {
  const endpoint = `${META_GRAPH}/${AD_ACCOUNT_ID}/ads`;

  if (!adsetId || !creativeId) {
    throw new Error("createAd: adsetId et creativeId requis");
  }

  const payload = {
    name: name || `Duumini Ad - ${new Date().toISOString()}`,
    adset_id: String(adsetId),
    creative: { creative_id: String(creativeId) },
    status: String(status || "PAUSED").toUpperCase(), // "PAUSED" | "ACTIVE"
  };

  return metaPost(endpoint, payload); // { id: "..." }
}

module.exports = {
  createAdCreative,
  createAd,
};
