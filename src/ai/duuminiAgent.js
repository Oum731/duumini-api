// src/ai/duuminiAgent.js
const { openai } = require("../lib/openai");
const { env } = require("../lib/env");

/* =========================
 * Model/params
 * ========================= */
function pickModel() {
  return env.OPENAI_MODEL || "gpt-5.2";
}
function pickTemp() {
  const n = Number(env.OPENAI_TEMPERATURE);
  return Number.isFinite(n) ? n : 0.4;
}
function pickMaxTokens(taskType) {
  const n = Number(env.OPENAI_MAX_TOKENS);
  if (Number.isFinite(n) && n > 0) return n;

  switch (taskType) {
    case "weekly_plan":
      return 1700;
    case "social_posts":
      return 1200;
    case "campaign_meta":
    case "campaign_google":
      return 1100;
    case "ads_meta":
    case "ads_google":
    case "ads_copy":
      return 900;
    case "whatsapp_reply":
      return 350;
    default:
      return 900;
  }
}

/* =========================
 * Helpers: JSON extraction
 * ========================= */
function extractJsonLoose(text) {
  const s = String(text || "").trim();

  const noFence = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(noFence);
  } catch {}

  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = noFence.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

/* =========================
 * Helpers: text constraints
 * ========================= */
function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}
function trimToMaxChars(s, max) {
  const t = cleanText(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(max * 0.6)) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

/* =========================
 * Meta CTA normalization
 * ========================= */
const META_CTA_ALLOWED = new Set([
  "SHOP_NOW",
  "LEARN_MORE",
  "CONTACT_US",
  "MESSAGE_PAGE",
  "SIGN_UP",
  "GET_OFFER",
  "CALL_NOW",
]);

function normalizeMetaCta(cta) {
  const raw = cleanText(cta).toUpperCase();
  const map = {
    COMMANDER: "SHOP_NOW",
    "COMMANDER MAINTENANT": "SHOP_NOW",
    ACHETER: "SHOP_NOW",
    "ACHETER MAINTENANT": "SHOP_NOW",
    "EN SAVOIR PLUS": "LEARN_MORE",
    "DÉCOUVRIR": "LEARN_MORE",
    CONTACTER: "CONTACT_US",
    "NOUS CONTACTER": "CONTACT_US",
    MESSAGE: "MESSAGE_PAGE",
    "ENVOYER UN MESSAGE": "MESSAGE_PAGE",
    "S'INSCRIRE": "SIGN_UP",
    OFFRE: "GET_OFFER",
    APPELER: "CALL_NOW",
  };

  const v = map[raw] || raw.replace(/\s+/g, "_");
  return META_CTA_ALLOWED.has(v) ? v : "SHOP_NOW";
}

/* =========================
 * Post-processors by task
 * ========================= */
function fixGoogleAdsPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const root = obj.google && typeof obj.google === "object" ? obj.google : obj;

  if (Array.isArray(root.keywords)) {
    root.keywords = root.keywords.map(cleanText).filter(Boolean).slice(0, 40);
  }

  if (Array.isArray(root.ads)) {
    root.ads = root.ads.slice(0, 5).map((ad) => {
      const a = ad && typeof ad === "object" ? ad : {};
      const headlines = Array.isArray(a.headlines) ? a.headlines : [];
      const descriptions = Array.isArray(a.descriptions) ? a.descriptions : [];

      return {
        ...a,
        headlines: [0, 1, 2].map((i) => trimToMaxChars(headlines[i] || "", 30)),
        descriptions: [0, 1].map((i) =>
          trimToMaxChars(descriptions[i] || "", 90)
        ),
        path: cleanText(a.path || a.path1 || "epicerie-africaine")
          .replace(/\s+/g, "-")
          .toLowerCase()
          .slice(0, 50),
        final_url: cleanText(
          a.final_url ||
            root.final_url ||
            env.DUUMINI_AI_MAIN_URL ||
            "https://duumini.com"
        ),
      };
    });
  }

  return obj;
}

function fixGoogleCampaignPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const g = obj.google && typeof obj.google === "object" ? obj.google : null;
  if (!g) return obj;

  if (Array.isArray(g.keywords)) {
    const allowed = new Set(["PHRASE", "EXACT", "BROAD"]);
    g.keywords = g.keywords
      .map((kw) => {
        const text = cleanText(kw?.text || "");
        const match = cleanText(kw?.match || "PHRASE").toUpperCase();
        return { text, match: allowed.has(match) ? match : "PHRASE" };
      })
      .filter((x) => x.text)
      .slice(0, 80);
  }

  if (Array.isArray(g.ads)) {
    g.ads = g.ads.slice(0, 3).map((ad) => {
      const a = ad && typeof ad === "object" ? ad : {};
      const headlines = Array.isArray(a.headlines) ? a.headlines : [];
      const descriptions = Array.isArray(a.descriptions) ? a.descriptions : [];
      return {
        ...a,
        headlines: [0, 1, 2].map((i) => trimToMaxChars(headlines[i] || "", 30)),
        descriptions: [0, 1].map((i) =>
          trimToMaxChars(descriptions[i] || "", 90)
        ),
        path1: trimToMaxChars(a.path1 || "epicerie", 15).replace(/\s+/g, "-"),
        path2: trimToMaxChars(a.path2 || "afrique", 15).replace(/\s+/g, "-"),
      };
    });
  }

  return obj;
}

function fixMetaAdsPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj.ads)) {
    obj.ads = obj.ads.slice(0, 5).map((ad) => {
      const a = ad && typeof ad === "object" ? ad : {};
      return {
        ...a,
        primary_text: trimToMaxChars(a.primary_text || "", 350),
        headline: trimToMaxChars(a.headline || "", 40),
        description: trimToMaxChars(a.description || "", 60),
        call_to_action: normalizeMetaCta(a.call_to_action || "SHOP_NOW"),
        angle: cleanText(a.angle || ""),
      };
    });
  }

  return obj;
}

function fixMetaCampaignPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const m = obj.meta && typeof obj.meta === "object" ? obj.meta : null;
  if (!m) return obj;

  if (m.campaign && typeof m.campaign === "object") {
    m.campaign.objective = cleanText(m.campaign.objective || "OUTCOME_SALES");
    m.campaign.status_default = cleanText(
      m.campaign.status_default || "PAUSED"
    ).toUpperCase();
  }

  if (m.adset && typeof m.adset === "object") {
    m.adset.daily_budget_mad = Number(m.adset.daily_budget_mad || 80) || 80;
    m.adset.days = Number(m.adset.days || 7) || 7;

    if (m.adset.targeting_hint && typeof m.adset.targeting_hint === "object") {
      const th = m.adset.targeting_hint;
      th.country = cleanText(th.country || "MA") || "MA";
      th.age_min = Number(th.age_min || 18) || 18;
      th.age_max = Number(th.age_max || 45) || 45;
      if (Array.isArray(th.cities)) {
        th.cities = th.cities.map(cleanText).filter(Boolean).slice(0, 10);
      }
    }
  }

  if (m.creative && typeof m.creative === "object") {
    m.creative.primary_text = trimToMaxChars(m.creative.primary_text || "", 350);
    m.creative.headline = trimToMaxChars(m.creative.headline || "", 40);
    m.creative.description = trimToMaxChars(m.creative.description || "", 60);
    m.creative.call_to_action = normalizeMetaCta(
      m.creative.call_to_action || "SHOP_NOW"
    );
  }

  return obj;
}

function postProcess(taskType, parsed) {
  switch (taskType) {
    case "ads_google":
      return fixGoogleAdsPayload(parsed);
    case "campaign_google":
      return fixGoogleCampaignPayload(parsed);
    case "ads_meta":
    case "ads_copy":
      return fixMetaAdsPayload(parsed);
    case "campaign_meta":
      return fixMetaCampaignPayload(parsed);
    default:
      return parsed;
  }
}

/* =========================
 * AUTO CONTEXT (Products API)
 * ========================= */

// Base API interne (ton backend). Mets-le en .env côté serveur.
function pickInternalApiBase() {
  return (
    env.INTERNAL_API_BASE ||
    process.env.INTERNAL_API_BASE ||
    "http://localhost:3000"
  );
}

async function httpGetJson(url, headers = {}) {
  const r = await fetch(url, { method: "GET", headers });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const err = new Error(`GET ${url} -> ${r.status} ${t?.slice(0, 200) || ""}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function summarizeProduct(p) {
  if (!p || typeof p !== "object") return null;
  const name = cleanText(p.name || "");
  if (!name) return null;

  const city = cleanText(p.shop_city || "");
  const shop = cleanText(p.shop_name || "");
  const price = safeNum(p.price);
  const currency = cleanText(p.currency || "MAD") || "MAD";

  const promoEligible = Number(p.promo_eligible || 0) === 1;
  const promoType = cleanText(p.promo_discount_type || "");
  const promoValue = p.promo_discount_value != null ? safeNum(p.promo_discount_value) : null;
  const promoFreeDelivery = Number(p.promo_free_delivery || 0) === 1;

  return {
    id: p.id,
    name,
    shop: shop || null,
    city: city || null,
    price,
    currency,
    channel: String(p.sub_category || "").trim().toLowerCase() === "food" ? "african-food" : "african-market",
    promo: promoEligible && promoValue
      ? {
          type: promoType || null,
          value: promoValue,
          free_delivery: promoFreeDelivery || undefined,
        }
      : null,
  };
}

async function buildAutoContext({ ville, channel, onlyActive = true } = {}) {
  const base = pickInternalApiBase();

  const q = new URLSearchParams();
  if (onlyActive) q.set("onlyActive", "true");
  if (ville) q.set("ville", ville);
  if (channel && channel !== "all") q.set("channel", channel);

  const promosUrl = `${base}/api/products/promotions?${q.toString()}&limit=12`;
  const topOrderedUrl = `${base}/api/products/top-ordered?${ville ? `ville=${encodeURIComponent(ville)}&` : ""}limit=8`;
  const topRatedUrl = `${base}/api/products/top-rated?${ville ? `ville=${encodeURIComponent(ville)}&` : ""}limit=8&minCount=2`;

  let promos = [];
  let topOrdered = [];
  let topRated = [];

  try {
    const [a, b, c] = await Promise.allSettled([
      httpGetJson(promosUrl),
      httpGetJson(topOrderedUrl),
      httpGetJson(topRatedUrl),
    ]);

    if (a.status === "fulfilled" && Array.isArray(a.value)) promos = a.value;
    if (b.status === "fulfilled" && Array.isArray(b.value)) topOrdered = b.value;
    if (c.status === "fulfilled" && Array.isArray(c.value)) topRated = c.value;
  } catch {}

  const promosMini = promos.map(summarizeProduct).filter(Boolean);
  const topOrderedMini = topOrdered.map(summarizeProduct).filter(Boolean);
  const topRatedMini = topRated.map(summarizeProduct).filter(Boolean);

  // “offre” dérivée uniquement des données réelles (pas inventée)
  const promoFacts = promosMini
    .filter((p) => p.promo && p.promo.value)
    .slice(0, 8)
    .map((p) => ({
      name: p.name,
      promo_type: p.promo.type,
      promo_value: p.promo.value,
      free_delivery: p.promo.free_delivery || false,
      city: p.city || null,
      shop: p.shop || null,
    }));

  return {
    generated_at: new Date().toISOString(),
    filters: { ville: ville || null, channel: channel || null, onlyActive: !!onlyActive },
    promos: promosMini,
    promo_facts: promoFacts,
    top_ordered: topOrderedMini,
    top_rated: topRatedMini,
  };
}

/* =========================
 * Main agent
 * ========================= */
/**
 * taskType:
 *  - "weekly_plan" | "social_posts" | "ads_meta" | "ads_google" | "ads_copy" | "whatsapp_reply"
 *  - "campaign_meta" | "campaign_google"
 *
 * AUTO:
 *  - payload.auto_context = true  => l’agent lit automatiquement tes routes produits
 *  - payload.ville / payload.channel optionnels
 */
async function runDuuminiAgent(taskType, payload = {}) {
  const brand = env.DUUMINI_AI_BRAND_NAME || "Duumini";
  const siteUrl = env.DUUMINI_AI_MAIN_URL || "https://duumini.com";

  const brandKit = {
    brand_name: brand,
    site_url: siteUrl,
    value_props: [
      "Produits d'Afrique subsaharienne au Maroc",
      "Paiement à la livraison",
      "Livraison locale (Casablanca prioritaire)",
      "Qualité & confiance",
    ],
    tone: "chaleureux, professionnel, simple, inclusif",
    ...((payload && payload.brand_kit && typeof payload.brand_kit === "object")
      ? payload.brand_kit
      : {}),
  };

  // ✅ AUTO context
  let autoContext = null;
  const wantsAuto = !!payload.auto_context && taskType !== "whatsapp_reply";
  if (wantsAuto) {
    autoContext = await buildAutoContext({
      ville: payload.ville || payload.city || null,
      channel: payload.channel || "all",
      onlyActive: payload.onlyActive !== false,
    });
  }

  const systemPrompt = `
Tu es l'agent marketing & communication officiel de ${brandKit.brand_name}.
Contexte marque (à respecter) :
- Site: ${brandKit.site_url}
- Positionnement: Marketplace de produits d'Afrique subsaharienne au Maroc (épicerie, plats, etc.).
- Cible: diaspora africaine au Maroc + Marocains intéressés par la cuisine africaine.
- Paiement: à la livraison. Livraison locale (Casablanca prioritaire).
- Valeurs: ${brandKit.value_props.join(" • ")}
- Ton: ${brandKit.tone} (touche d'Afrique, mais compréhensible)

Règles NON négociables :
- Ne JAMAIS inventer une promotion, un pourcentage, un montant, une gratuité, un délai si ce n'est pas présent dans les données fournies.
- Si aucune promo n'est fournie, rédiger des messages neutres (qualité, découverte, paiement à la livraison).
- Quand on demande du JSON: répondre en JSON valide uniquement (aucun texte autour).
- CTA Meta: uniquement (SHOP_NOW, LEARN_MORE, CONTACT_US, MESSAGE_PAGE, SIGN_UP, GET_OFFER, CALL_NOW).

Données produits (si présentes) :
- Utiliser les produits/promos/top fournis pour inspirer les textes.
- Ne pas citer un prix exact si le prix n'est pas explicitement fourni dans le contexte.
`.trim();

  // bloc contexte auto (injecté dans le prompt user)
  const contextBlock = autoContext
    ? `
CONTEXTE AUTO (données réelles de l'API produits):
${JSON.stringify(autoContext)}
`
    : "";

  let userPrompt = "";

  switch (taskType) {
    case "weekly_plan": {
      const { focus = "épicerie africaine", city = "Casablanca", language = "fr" } = payload;

      userPrompt = `
${contextBlock}
Tâche: Créer un plan marketing complet pour la semaine pour ${brandKit.brand_name} à ${city}.
Focus produits: ${focus}
Langue: ${language}

Répond STRICTEMENT en JSON valide :
{
  "strategy_summary": "résumé de la stratégie en 5-8 lignes",
  "audience": ["segment 1", "segment 2"],
  "weekly_theme": "thème principal de la semaine",
  "content_calendar": [
    {
      "day": "Lundi",
      "time": "18:00",
      "channel": "Instagram",
      "format": "Post feed / Story / Reel",
      "topic": "idée de contenu",
      "caption": "légende complète",
      "hashtags": ["..."]
    }
  ],
  "promo_ideas": ["idée 1", "idée 2"]
}
`.trim();
      break;
    }

    case "social_posts": {
      const {
        objective = "augmenter les commandes cette semaine",
        product = "sélection Duumini",
        count = 5,
        language = "fr",
        channels = ["Instagram", "Facebook"],
      } = payload;

      userPrompt = `
${contextBlock}
Tâche: Générer ${Number(count) || 5} posts réseaux sociaux pour ${brandKit.brand_name}.
Objectif: ${objective}
Produit / thème: ${product}
Langue: ${language}
Canaux: ${channels.join(", ")}

Répond STRICTEMENT en JSON valide :
{
  "posts": [
    {
      "channel": "Instagram",
      "goal": "explication / promo / notoriété / témoignage",
      "hook": "accroche forte",
      "caption": "légende complète prête à publier",
      "hashtags": ["..."],
      "suggested_visual": "idée de visuel"
    }
  ],
  "story_ideas": ["idée 1", "idée 2"]
}
`.trim();
      break;
    }

    case "ads_meta":
    case "ads_copy": {
      const {
        objective = "conversion (commandes)",
        url = siteUrl,
        audience = "Diaspora africaine au Maroc + Marocains curieux",
        variants = 3,
      } = payload;

      // ✅ si autoContext présent et qu’il y a de vraies promos, on demande de les utiliser.
      const offerHint =
        autoContext?.promo_facts?.length
          ? `Utilise UNIQUEMENT ces promos réelles si tu en parles: ${JSON.stringify(autoContext.promo_facts)}`
          : "Aucune promo confirmée. Reste neutre (qualité, découverte, paiement à la livraison).";

      userPrompt = `
${contextBlock}
Tâche: Générer ${Number(variants) || 3} variantes de publicités Meta Ads pour ${brandKit.brand_name}.
Objectif: ${objective}
URL: ${url}
Audience: ${audience}
${offerHint}

Contraintes:
- primary_text: max ~350 caractères, 1 à 4 phrases.
- headline: max 40 caractères.
- description: max 60 caractères.
- call_to_action: uniquement: SHOP_NOW, LEARN_MORE, CONTACT_US, MESSAGE_PAGE, SIGN_UP, GET_OFFER, CALL_NOW.

Répond STRICTEMENT en JSON valide :
{
  "ads": [
    {
      "primary_text": "...",
      "headline": "...",
      "description": "...",
      "call_to_action": "SHOP_NOW",
      "angle": "qualité/diaspora/nosalgie/découverte/rapidité..."
    }
  ]
}
`.trim();
      break;
    }

    case "ads_google": {
      const {
        objective = "vente en ligne de produits africains",
        url = siteUrl,
        audience = "personnes au Maroc cherchant des produits ou plats africains",
        variants = 3,
      } = payload;

      const offerHint =
        autoContext?.promo_facts?.length
          ? `Si tu mentionnes une promo, utilise UNIQUEMENT celles-ci: ${JSON.stringify(autoContext.promo_facts)}`
          : "Ne mentionne aucune promo.";

      userPrompt = `
${contextBlock}
Tâche: Générer des assets Google Ads Search pour ${brandKit.brand_name}.
Objectif: ${objective}
Landing: ${url}
Audience: ${audience}
${offerHint}

Contraintes STRICTES:
- headlines: 3 titres max 30 caractères chacun
- descriptions: 2 descriptions max 90 caractères chacune
- path: slug simple (ex: epicerie-africaine)
- final_url: ${url}

Répond STRICTEMENT en JSON valide :
{
  "keywords": ["mot clé 1", "mot clé 2"],
  "ads": [
    {
      "headlines": ["...", "...", "..."],
      "descriptions": ["...", "..."],
      "path": "epicerie-africaine",
      "final_url": "${url}"
    }
  ]
}
`.trim();
      break;
    }

    case "campaign_meta": {
      const {
        objective = "SALES",
        url = siteUrl,
        audience = "Diaspora africaine au Maroc (Casablanca/Marrakech), 18-45",
        daily_budget_mad = 80,
        days = 7,
        city_focus = "Casablanca",
      } = payload;

      const offerHint =
        autoContext?.promo_facts?.length
          ? `Promos réelles dispo: ${JSON.stringify(autoContext.promo_facts)}`
          : "Aucune promo confirmée.";

      userPrompt = `
${contextBlock}
Tâche: Créer une CAMPAGNE Meta complète pour ${brandKit.brand_name}.
Objectif: ${objective}
URL: ${url}
Audience: ${audience}
Budget/jour (MAD): ${daily_budget_mad}
Durée (jours): ${days}
Ville focus: ${city_focus}
${offerHint}

Contraintes:
- Ne pas inventer de promo.
- call_to_action: enum Meta uniquement.

Répond STRICTEMENT en JSON valide :
{
  "meta": {
    "campaign": {
      "name": "...",
      "objective": "OUTCOME_SALES",
      "status_default": "PAUSED"
    },
    "adset": {
      "name": "...",
      "daily_budget_mad": ${Number(daily_budget_mad) || 80},
      "days": ${Number(days) || 7},
      "targeting_hint": {
        "country": "MA",
        "cities": ["Casablanca", "Marrakech"],
        "age_min": 18,
        "age_max": 45
      }
    },
    "creative": {
      "primary_text": "...",
      "headline": "...",
      "description": "...",
      "call_to_action": "SHOP_NOW"
    }
  }
}
`.trim();
      break;
    }

    case "campaign_google": {
      const {
        objective = "Conversions",
        url = siteUrl,
        audience = "Diaspora Afrique subsaharienne au Maroc, 18-45",
        variants = 2,
        city_focus = "Casablanca",
      } = payload;

      const offerHint =
        autoContext?.promo_facts?.length
          ? `Promos réelles dispo: ${JSON.stringify(autoContext.promo_facts)}`
          : "Ne mentionne aucune promo.";

      userPrompt = `
${contextBlock}
Tâche: Créer une CAMPAGNE Google Ads Search pour ${brandKit.brand_name}.
Objectif: ${objective}
Landing: ${url}
Audience: ${audience}
Ville focus: ${city_focus}
Variants: ${variants}
${offerHint}

Contraintes STRICTES:
- Headlines max 30 caractères
- Descriptions max 90 caractères
- Pas de fausses promos

Répond STRICTEMENT en JSON valide :
{
  "google": {
    "campaign_name": "...",
    "adgroup_name": "...",
    "final_url": "${url}",
    "keywords": [
      { "text": "epicerie africaine", "match": "PHRASE" },
      { "text": "produits africains casablanca", "match": "PHRASE" }
    ],
    "ads": [
      {
        "headlines": ["...", "...", "..."],
        "descriptions": ["...", "..."],
        "path1": "epicerie",
        "path2": "afrique"
      }
    ]
  }
}
`.trim();
      break;
    }

    case "whatsapp_reply": {
      const {
        message,
        context = "client final qui se renseigne sur une commande",
        language = "fr",
      } = payload;

      userPrompt = `
Tâche: Répondre à un message WhatsApp d'un client ${brandKit.brand_name}.
Message client:
"""${message}"""

Contexte: ${context}
Langue: ${language}

Contraintes:
- 1 à 4 phrases max.
- Action claire.
- Ton chaleureux, rassurant, précis.

Répond uniquement avec le texte du message WhatsApp (pas de JSON).
`.trim();
      break;
    }

    default:
      throw new Error(`Task type non supporté: ${taskType}`);
  }

  const wantsJson = taskType !== "whatsapp_reply";

  const request = {
    model: pickModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: pickTemp(),
    max_tokens: pickMaxTokens(taskType),
  };

  if (wantsJson) request.response_format = { type: "json_object" };

  const completion = await openai.chat.completions.create(request);
  const content = completion?.choices?.[0]?.message?.content || "";

  if (taskType === "whatsapp_reply") return cleanText(content);

  let parsed = extractJsonLoose(content);
  if (!parsed) return { raw: String(content || ""), auto_context: autoContext || undefined };

  parsed = postProcess(taskType, parsed);

  // on peut renvoyer le contexte utilisé (pratique pour debug/copie)
  if (payload.include_context) {
    return { ...parsed, _context: autoContext };
  }

  return parsed;
}

module.exports = { runDuuminiAgent };
