// src/ai/duuminiAgent.js
const { openai } = require("../lib/openai");
const { env } = require("../lib/env");

/* =========================
 * Fetch (Node < 18 fallback)
 * =======================*/
let fetchFn = global.fetch;
if (!fetchFn) fetchFn = require("node-fetch");

/* =========================
 * Model/params
 * =======================*/
function pickModel() {
  return env.OPENAI_MODEL || "gpt-4o-mini";
}
function pickTemp() {
  const n = Number(env.OPENAI_TEMPERATURE);
  return Number.isFinite(n) ? n : 0.4;
}
function pickMaxTokens(taskType) {
  const n = Number(env.OPENAI_MAX_TOKENS);
  if (Number.isFinite(n) && n > 0) return n;

  switch (taskType) {
    case "seo_optimize_page":
      return 1600;
    case "seo_generate_city_page":
      return 1700;
    case "seo_audit":
      return 1200;
    case "ads_meta":
    case "ads_google":
      return 900;
    case "campaign_meta":
    case "campaign_google":
    case "weekly_plan":
      return 1400;
    case "social_posts":
      return 1200;
    default:
      return 1200;
  }
}

/* =========================
 * Helpers: JSON extraction
 * =======================*/
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
 * =======================*/
function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}
function trimToMaxChars(s, max) {
  const t = cleanText(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(max * 0.6)) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

function arr(obj) {
  return Array.isArray(obj) ? obj : [];
}
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function normalizeKeywords(list) {
  return arr(list)
    .map((k) => ({
      text: cleanText(k?.text || ""),
      match: ["BROAD", "PHRASE", "EXACT"].includes(String(k?.match || "").toUpperCase())
        ? String(k.match).toUpperCase()
        : "PHRASE",
    }))
    .filter((k) => k.text)
    .slice(0, 20);
}

/* =========================
 * Simple SEO score (backend)
 * =======================*/
function scoreSeo(payload) {
  // score /10 : meta + longueur + FAQ + headings
  if (!payload || typeof payload !== "object") return 0;

  const meta = payload.meta || {};
  const title = cleanText(meta.title || "");
  const desc = cleanText(meta.description || "");
  const h1 = cleanText(payload.h1 || "");
  const body = cleanText(payload.body || "");
  const faq = arr(payload.faq);

  let score = 0;

  // meta title 50-60
  if (title.length >= 45 && title.length <= 65) score += 2;
  else if (title.length >= 30) score += 1;

  // meta desc 140-170
  if (desc.length >= 130 && desc.length <= 175) score += 2;
  else if (desc.length >= 90) score += 1;

  // H1
  if (h1.length >= 10) score += 1;

  // body length (approx)
  const words = body ? body.split(/\s+/).filter(Boolean).length : 0;
  if (words >= 700) score += 3;
  else if (words >= 350) score += 2;
  else if (words >= 150) score += 1;

  // FAQ
  if (faq.length >= 3) score += 2;
  else if (faq.length >= 1) score += 1;

  // clamp
  if (score > 10) score = 10;
  return Number(score.toFixed(2));
}

/* =========================
 * Schema helpers (json-ld)
 * =======================*/
function buildFaqJsonLd(faq = []) {
  const items = arr(faq)
    .map((x) => ({
      q: cleanText(x?.q || x?.question || ""),
      a: cleanText(x?.a || x?.answer || ""),
    }))
    .filter((x) => x.q && x.a)
    .slice(0, 10);

  if (!items.length) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
}

function buildOrgJsonLd(brandName, siteUrl) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: brandName,
    url: siteUrl,
  };
}

function buildWebSiteJsonLd(brandName, siteUrl) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: brandName,
    url: siteUrl,
  };
}

/* =========================
 * MAIN (SEO ONLY)
 * =======================*/
/**
 * taskType:
 *  - "seo_optimize_page"
 *  - "seo_generate_city_page"
 *  - "seo_audit"
 *
 * payload:
 *  - slug, lang, current (optional), city(optional), keywords(optional), internal_links(optional)
 */
const MARKETING_TASKS = [
  "ads_meta",
  "ads_google",
  "campaign_meta",
  "campaign_google",
  "social_posts",
  "weekly_plan",
];

async function runDuuminiAgent(taskType, payload = {}) {
  const brand = env.DUUMINI_AI_BRAND_NAME || "Duumini";
  const siteUrl = env.DUUMINI_AI_MAIN_URL || "https://www.duumini.com";
  const isMarketingTask = MARKETING_TASKS.includes(taskType);

  const seoSystemPrompt = `
Tu es l'agent SEO & contenu officiel de ${brand}.
Objectif: améliorer le référencement (Google) et la qualité du contenu du site.
Langue principale: français (FR). Ne mélange pas les langues.

Règles NON négociables:
- Ne JAMAIS inventer une promotion, un pourcentage, un prix, un délai de livraison, ou une gratuité.
- Si une info n'est pas fournie, rester générique et vrai (qualité, confiance, paiement à la livraison).
- Répondre STRICTEMENT en JSON valide uniquement (aucun texte autour).
- Le contenu doit être naturel, utile, et orienté utilisateur (pas du bourrage de mots-clés).
- Générer du contenu adapté au Maroc (villes, habitudes, mots-clés locaux) sans affirmer des faits non fournis.
`.trim();

  const marketingSystemPrompt = `
Tu es l'agent marketing & publicité officiel de ${brand}.
Objectif: produire des textes publicitaires et du contenu marketing clairs, convaincants et conformes aux règles des plateformes (Meta Ads, Google Ads).
Langue principale: français (FR). Ne mélange pas les langues.

Règles NON négociables:
- Ne JAMAIS inventer une promotion, un pourcentage, un prix, un délai de livraison, ou une gratuité qui ne serait pas fournie dans le contexte.
- Si une info n'est pas fournie, rester générique et vrai (qualité, confiance, paiement à la livraison, large choix de produits africains).
- Répondre STRICTEMENT en JSON valide uniquement (aucun texte autour).
- Respecter strictement les limites de caractères indiquées pour chaque plateforme.
- Contenu adapté au Maroc (villes, habitudes) sans affirmer des faits non fournis.
`.trim();

  const systemPrompt = isMarketingTask ? marketingSystemPrompt : seoSystemPrompt;

  const slug = cleanText(payload.slug || "");
  const lang = cleanText(payload.lang || "fr") || "fr";
  const city = cleanText(payload.city || payload.ville || "");
  const current = payload.current && typeof payload.current === "object" ? payload.current : null;

  const baseJsonSpec = `
Format JSON attendu:
{
  "h1": "....",
  "sections": [
    { "h2": "....", "body": "..." }
  ],
  "body": "texte complet (optionnel, mais recommandé)",
  "faq": [ { "q": "...", "a": "..." } ],
  "meta": { "title": "...", "description": "...", "keywords": ["..."] },
  "internal_links": [ { "label": "...", "href": "..." } ],
  "notes": "courte note (optionnelle) sur ce qui a été amélioré"
}
`.trim();

  let userPrompt = "";

  if (taskType === "seo_optimize_page") {
    if (!slug) throw new Error("seo_optimize_page: slug requis");

    const targetKeywords = arr(payload.keywords).map(cleanText).filter(Boolean).slice(0, 15);
    const internalLinks = arr(payload.internal_links)
      .map((x) => ({
        label: cleanText(x?.label || ""),
        href: cleanText(x?.href || ""),
      }))
      .filter((x) => x.label && x.href)
      .slice(0, 12);

    userPrompt = `
Tâche: optimiser une page du site (SEO + clarté) sans inventer d'infos.
Page slug: ${slug}
Lang: ${lang}
Site: ${siteUrl}
Marque: ${brand}

Contexte actuel (si fourni):
${current ? JSON.stringify(current) : "null"}

Mots-clés cibles (si fournis):
${targetKeywords.length ? JSON.stringify(targetKeywords) : "[]"}

Liens internes suggérés (si fournis):
${internalLinks.length ? JSON.stringify(internalLinks) : "[]"}

Contraintes:
- Meta title ~ 50-60 caractères
- Meta description ~ 150-160 caractères
- Texte utile, naturel, orienté utilisateur au Maroc.
- FAQ: 3 à 6 questions.
- Éviter répétitions.

${baseJsonSpec}
`.trim();
  } else if (taskType === "seo_generate_city_page") {
    const cityName = city || "Casablanca";
    const pageSlug = slug || `${cityName.toLowerCase()}/produits-africains`.replace(/\s+/g, "-");

    const targetKeywords = arr(payload.keywords).map(cleanText).filter(Boolean).slice(0, 15);

    userPrompt = `
Tâche: générer une page SEO locale (ville) pour ${brand}.
Ville: ${cityName}
Slug: ${pageSlug}
Lang: ${lang}
Site: ${siteUrl}

Objectif:
- se positionner sur les recherches liées à "produits africains" + ville au Maroc
- contenu unique, utile, naturel

Mots-clés cibles (si fournis):
${targetKeywords.length ? JSON.stringify(targetKeywords) : "[]"}

Contraintes:
- 800 à 1200 mots (approx)
- FAQ: 4 à 7 questions
- Mentionner paiement à la livraison (sans inventer délais)
- Proposer 6-10 liens internes (catégories, pages du site, etc.) sans inventer des URLs inexistantes (utiliser des chemins plausibles)

${baseJsonSpec}
`.trim();
  } else if (taskType === "seo_audit") {
    const urls = arr(payload.urls).map(cleanText).filter(Boolean).slice(0, 30);

    userPrompt = `
Tâche: audit SEO (contenu) pour ${brand}.
Lang: ${lang}
Site: ${siteUrl}

Pages à auditer (si fournies):
${urls.length ? JSON.stringify(urls) : "[]"}

Répond STRICTEMENT en JSON:
{
  "summary": "résumé en 6-10 lignes",
  "priorities": [
    { "title": "priorité", "why": "pourquoi", "actions": ["action 1", "action 2"] }
  ],
  "content_gaps": ["..."],
  "internal_linking": ["..."],
  "meta_guidelines": { "title": "....", "description": "..." }
}
`.trim();
  } else if (taskType === "ads_meta") {
    const objective = cleanText(payload.objective || "vente en ligne de produits africains");
    const offer = cleanText(payload.offer || "épicerie et plats africains livrés au Maroc");
    const url = cleanText(payload.url || siteUrl);
    const audience = cleanText(payload.audience || "personnes au Maroc cherchant des produits africains");
    const variants = clamp(Number(payload.variants) || 2, 1, 5);

    userPrompt = `
Tâche: rédiger ${variants} variante(s) de publicité Meta (Facebook/Instagram).
Objectif: ${objective}
Offre: ${offer}
URL: ${url}
Audience: ${audience}

Contraintes par variante:
- primary_text: 90 à 125 caractères, accrocheur, orienté bénéfice
- headline: max 40 caractères
- description: max 30 caractères
- call_to_action: une valeur Meta standard (ex: SHOP_NOW, LEARN_MORE, ORDER_NOW)

Réponds STRICTEMENT en JSON (exactement ${variants} élément(s) dans "ads"):
{ "ads": [ { "primary_text": "...", "headline": "...", "description": "...", "call_to_action": "..." } ] }
`.trim();
  } else if (taskType === "ads_google") {
    const objective = cleanText(payload.objective || "vente en ligne de produits africains");
    const offer = cleanText(payload.offer || "épicerie et plats africains livrés au Maroc");
    const url = cleanText(payload.url || siteUrl);
    const audience = cleanText(payload.audience || "personnes au Maroc cherchant des produits africains");

    userPrompt = `
Tâche: rédiger une annonce Google Ads Search responsive (RSA) + mots-clés associés.
Objectif: ${objective}
Offre: ${offer}
URL: ${url}
Audience: ${audience}

Contraintes:
- headlines: 8 à 12 titres, max 30 caractères chacun
- descriptions: 3 à 4 descriptions, max 90 caractères chacune
- keywords: 10 à 20 mots-clés pertinents avec un type de correspondance

Réponds STRICTEMENT en JSON:
{
  "ads": [ { "headlines": ["..."], "descriptions": ["..."] } ],
  "keywords": [ { "text": "...", "match": "PHRASE" } ]
}
`.trim();
  } else if (taskType === "campaign_meta") {
    const objective = cleanText(payload.objective || "vente en ligne de produits africains");
    const offer = cleanText(payload.offer || "épicerie et plats africains livrés au Maroc");
    const url = cleanText(payload.url || siteUrl);
    const audience = cleanText(payload.audience || "personnes au Maroc cherchant des produits africains");
    const dailyBudget = Number(payload.daily_budget_mad) || 80;
    const days = Number(payload.days) || 7;
    const cityFocus = cleanText(payload.city_focus || "Casablanca");

    userPrompt = `
Tâche: construire une campagne publicitaire Meta complète (campagne + ensemble de publicités + publicité).
Objectif: ${objective}
Offre: ${offer}
URL: ${url}
Audience: ${audience}
Budget quotidien indicatif: ${dailyBudget} MAD
Durée indicative: ${days} jour(s)
Ville prioritaire: ${cityFocus}

Contraintes créatif:
- primary_text: 90 à 125 caractères
- headline: max 40 caractères
- description: max 30 caractères

Réponds STRICTEMENT en JSON:
{
  "meta": {
    "campaign": { "name": "...", "objective": "OUTCOME_SALES" },
    "adset": { "name": "...", "daily_budget_mad": ${dailyBudget}, "targeting_hint": { "cities": ["${cityFocus}"], "age_min": 18, "age_max": 55, "interests": ["..."] } },
    "creative": { "primary_text": "...", "headline": "...", "description": "...", "call_to_action": "SHOP_NOW" }
  }
}
`.trim();
  } else if (taskType === "campaign_google") {
    const objective = cleanText(payload.objective || "vente en ligne de produits africains");
    const offer = cleanText(payload.offer || "épicerie et plats africains livrés au Maroc");
    const url = cleanText(payload.url || siteUrl);
    const audience = cleanText(payload.audience || "personnes au Maroc cherchant des produits africains");

    userPrompt = `
Tâche: construire une campagne Google Ads Search complète (nom de campagne, groupe d'annonces, annonce RSA, mots-clés).
Objectif: ${objective}
Offre: ${offer}
URL: ${url}
Audience: ${audience}

Contraintes:
- headlines: exactement 3, max 30 caractères chacun
- descriptions: exactement 2, max 90 caractères chacune
- path1/path2: max 15 caractères chacun
- keywords: 8 à 15 mots-clés

Réponds STRICTEMENT en JSON:
{
  "google": {
    "campaign_name": "...",
    "adgroup_name": "...",
    "final_url": "${url}",
    "ads": [ { "headlines": ["...","...","..."], "descriptions": ["...","..."], "path1": "...", "path2": "..." } ],
    "keywords": [ { "text": "...", "match": "PHRASE" } ]
  }
}
`.trim();
  } else if (taskType === "social_posts") {
    const ville = cleanText(payload.ville || "Casablanca");
    const channel = cleanText(payload.channel || "all");

    userPrompt = `
Tâche: proposer 5 publications réseaux sociaux (Instagram/Facebook) pour promouvoir ${brand}.
Ville prioritaire: ${ville}
Canal/catégorie: ${channel}

Réponds STRICTEMENT en JSON (exactement 5 éléments, mélange instagram/facebook):
{ "posts": [ { "platform": "instagram", "caption": "...", "hashtags": ["#..."], "cta": "..." } ] }
`.trim();
  } else if (taskType === "weekly_plan") {
    const ville = cleanText(payload.ville || "Casablanca");
    const channel = cleanText(payload.channel || "all");

    userPrompt = `
Tâche: proposer un planning marketing hebdomadaire (7 jours) pour ${brand}.
Ville prioritaire: ${ville}
Canal/catégorie: ${channel}

Réponds STRICTEMENT en JSON (exactement 7 éléments, un par jour de la semaine):
{ "plan": [ { "day": "Lundi", "theme": "...", "channel": "instagram", "action": "..." } ] }
`.trim();
  } else {
    throw new Error(`Task type non supporté: ${taskType}`);
  }

  const request = {
    model: pickModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: pickTemp(),
    max_tokens: pickMaxTokens(taskType),
  };

  // optionnel : certains modèles supportent response_format, d'autres non
  const useResponseFormat = String(env.OPENAI_RESPONSE_FORMAT || "0") === "1";
  if (useResponseFormat) request.response_format = { type: "json_object" };

  const completion = await openai.chat.completions.create(request);
  const content = completion?.choices?.[0]?.message?.content || "";

  let parsed = extractJsonLoose(content);
  if (!parsed) return { raw: String(content || "") };

  if (isMarketingTask) {
    if (taskType === "ads_meta") {
      parsed.ads = arr(parsed.ads)
        .map((a) => ({
          primary_text: trimToMaxChars(a?.primary_text || "", 125),
          headline: trimToMaxChars(a?.headline || "", 40),
          description: trimToMaxChars(a?.description || "", 30),
          call_to_action: cleanText(a?.call_to_action || "SHOP_NOW"),
        }))
        .filter((a) => a.primary_text && a.headline);
    } else if (taskType === "ads_google") {
      parsed.ads = arr(parsed.ads).map((a) => ({
        headlines: arr(a?.headlines).map((h) => trimToMaxChars(h, 30)).filter(Boolean).slice(0, 15),
        descriptions: arr(a?.descriptions).map((d) => trimToMaxChars(d, 90)).filter(Boolean).slice(0, 4),
      }));
      parsed.keywords = normalizeKeywords(parsed.keywords);
    } else if (taskType === "campaign_meta") {
      const m = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
      parsed.meta = {
        campaign: {
          name: cleanText(m.campaign?.name || `Duumini Campaign ${new Date().toISOString().slice(0, 10)}`),
          objective: cleanText(m.campaign?.objective || "OUTCOME_SALES"),
        },
        adset: {
          name: cleanText(m.adset?.name || "Duumini AdSet"),
          daily_budget_mad: Number(m.adset?.daily_budget_mad) || 80,
          targeting_hint:
            m.adset?.targeting_hint && typeof m.adset.targeting_hint === "object" ? m.adset.targeting_hint : {},
        },
        creative: {
          primary_text: trimToMaxChars(m.creative?.primary_text || "", 125),
          headline: trimToMaxChars(m.creative?.headline || "", 40),
          description: trimToMaxChars(m.creative?.description || "", 30),
          call_to_action: cleanText(m.creative?.call_to_action || "SHOP_NOW"),
        },
      };
    } else if (taskType === "campaign_google") {
      const g = parsed.google && typeof parsed.google === "object" ? parsed.google : {};
      const ad0 = arr(g.ads)[0] || {};
      parsed.google = {
        campaign_name: cleanText(g.campaign_name || "Duumini Campaign"),
        adgroup_name: cleanText(g.adgroup_name || "AdGroup 1"),
        final_url: cleanText(g.final_url || siteUrl),
        ads: [
          {
            headlines: arr(ad0.headlines).map((h) => trimToMaxChars(h, 30)).filter(Boolean).slice(0, 3),
            descriptions: arr(ad0.descriptions).map((d) => trimToMaxChars(d, 90)).filter(Boolean).slice(0, 2),
            path1: trimToMaxChars(ad0.path1 || "", 15),
            path2: trimToMaxChars(ad0.path2 || "", 15),
          },
        ],
        keywords: normalizeKeywords(g.keywords),
      };
    } else if (taskType === "social_posts") {
      parsed.posts = arr(parsed.posts)
        .map((p) => ({
          platform: cleanText(p?.platform || "instagram"),
          caption: cleanText(p?.caption || ""),
          hashtags: arr(p?.hashtags).map(cleanText).filter(Boolean).slice(0, 15),
          cta: cleanText(p?.cta || ""),
        }))
        .filter((p) => p.caption)
        .slice(0, 10);
    } else if (taskType === "weekly_plan") {
      parsed.plan = arr(parsed.plan)
        .map((d) => ({
          day: cleanText(d?.day || ""),
          theme: cleanText(d?.theme || ""),
          channel: cleanText(d?.channel || ""),
          action: cleanText(d?.action || ""),
        }))
        .filter((d) => d.day)
        .slice(0, 7);
    }

    return parsed;
  }

  // Post-process (SEO): normaliser/champs
  parsed.h1 = cleanText(parsed.h1 || "");
  parsed.body = cleanText(parsed.body || "");
  parsed.sections = arr(parsed.sections)
    .map((s) => ({ h2: cleanText(s?.h2 || ""), body: cleanText(s?.body || "") }))
    .filter((s) => s.h2 && s.body)
    .slice(0, 12);

  parsed.faq = arr(parsed.faq)
    .map((f) => ({ q: cleanText(f?.q || f?.question || ""), a: cleanText(f?.a || f?.answer || "") }))
    .filter((f) => f.q && f.a)
    .slice(0, 10);

  parsed.meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  parsed.meta.title = trimToMaxChars(parsed.meta.title || parsed.h1 || brand, 65);
  parsed.meta.description = trimToMaxChars(parsed.meta.description || parsed.body || "", 175);
  parsed.meta.keywords = arr(parsed.meta.keywords).map(cleanText).filter(Boolean).slice(0, 25);

  parsed.internal_links = arr(parsed.internal_links)
    .map((x) => ({ label: cleanText(x?.label || ""), href: cleanText(x?.href || "") }))
    .filter((x) => x.label && x.href)
    .slice(0, 20);

  // Add schema JSON-LD computed backend-side (stable)
  const faqJsonLd = buildFaqJsonLd(parsed.faq);
  parsed.schema = {
    organization: buildOrgJsonLd(brand, siteUrl),
    website: buildWebSiteJsonLd(brand, siteUrl),
    faq: faqJsonLd,
  };

  parsed.score = scoreSeo(parsed);

  return parsed;
}

module.exports = { runDuuminiAgent, scoreSeo };
