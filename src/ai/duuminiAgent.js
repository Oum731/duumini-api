// api/ai/duuminiAgent.js
const { openai } = require("../lib/openai");
const { env } = require("../lib/env");

function pickModel() {
  return env.OPENAI_MODEL || "gpt-5.2";
}
function pickTemp() {
  const n = Number(env.OPENAI_TEMPERATURE);
  return Number.isFinite(n) ? n : 0.4;
}
function pickMaxTokens() {
  const n = Number(env.OPENAI_MAX_TOKENS);
  return Number.isFinite(n) ? n : 1500;
}

function extractJsonLoose(text) {
  const s = String(text || "").trim();
  // retire ```json ... ```
  const noFence = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // essaye parse direct
  try {
    return JSON.parse(noFence);
  } catch {}

  // fallback: extrait le premier objet JSON trouvé
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

/**
 * Agent IA marketing/communication spécial Duumini
 * taskType: "weekly_plan" | "social_posts" | "ads_meta" | "ads_google" | "ads_copy" | "whatsapp_reply"
 */
async function runDuuminiAgent(taskType, payload = {}) {
  const brand = env.DUUMINI_AI_BRAND_NAME || "Duumini";
  const siteUrl = env.DUUMINI_AI_MAIN_URL || "https://duumini.com";

  const systemPrompt = `
Tu es l'agent marketing & communication officiel de ${brand}.
Contexte :
- Marketplace de produits d'Afrique subsaharienne au Maroc (épicerie, plats, etc.).
- Cible principale : diaspora africaine au Maroc + Marocains intéressés par la cuisine africaine.
- Paiement à la livraison, livraison locale (Casablanca prioritaire, puis autres villes).
- Ton de voix : chaleureux, professionnel, simple, inclusif, avec une touche d'Afrique.
- Toujours encourager le passage à l'action (commander, visiter ${siteUrl}, répondre au message).

Règles générales :
- Ne pas inventer de promos si l'utilisateur ne les mentionne pas.
- Utiliser un français clair, parfois quelques expressions africaines mais compréhensibles.
- Mettre en avant la proximité, la qualité, la confiance, la diaspora.
- Si tu dois répondre en JSON: réponds STRICTEMENT en JSON valide, sans texte autour.
`.trim();

  let userPrompt = "";

  switch (taskType) {
    case "weekly_plan": {
      const {
        focus = "épicerie africaine (épices, féculents, sauces)",
        city = "Casablanca",
        language = "fr",
      } = payload;

      userPrompt = `
Tâche: Créer un plan marketing complet pour la semaine pour ${brand} à ${city}.
Focus produits: ${focus}
Langue: ${language}

Délivre un JSON structuré avec:
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
Répond STRICTEMENT en JSON valide, rien d'autre.
`.trim();
      break;
    }

    case "social_posts": {
      const {
        objective = "augmenter les commandes cette semaine",
        product = "panier d'épicerie africaine",
        count = 5,
        language = "fr",
        channels = ["Instagram", "Facebook"],
      } = payload;

      userPrompt = `
Tâche: Générer ${count} posts réseaux sociaux pour ${brand}.
Objectif: ${objective}
Produit / offre: ${product}
Langue: ${language}
Canaux principaux: ${channels.join(", ")}

Délivre un JSON structuré:
{
  "posts": [
    {
      "channel": "Instagram",
      "goal": "explication / promo / notoriété / témoignage",
      "hook": "phrase d'accroche forte",
      "caption": "légende complète prête à publier",
      "hashtags": ["..."],
      "suggested_visual": "idée de visuel pour Canva/Designer"
    }
  ],
  "story_ideas": ["idée 1", "idée 2"]
}
Répond STRICTEMENT en JSON valide, rien d'autre.
`.trim();
      break;
    }

    case "ads_meta":
    case "ads_copy": {
      const {
        objective = "conversion (commandes)",
        offer = "Livraison de produits africains à Casablanca",
        url = siteUrl,
        audience = "Africains vivant à Casablanca + Marocains curieux",
        variants = 3,
      } = payload;

      userPrompt = `
Tâche: Générer ${variants} textes de publicités Meta Ads (Facebook & Instagram) pour ${brand}.
Objectif: ${objective}
Offre: ${offer}
URL de destination: ${url}
Audience cible: ${audience}

Délivre un JSON structuré:
{
  "ads": [
    {
      "primary_text": "texte principal de la pub (max 3-4 lignes, accroche fort)",
      "headline": "titre court et percutant (max ~40 caractères)",
      "description": "phrase complémentaire (facultatif, max ~60 caractères)",
      "call_to_action": "ex: Commander maintenant, En savoir plus",
      "angle": "angle marketing utilisé (prix, qualité, diaspora, nostalgie, découverte, etc.)"
    }
  ]
}
Répond STRICTEMENT en JSON valide, rien d'autre.
`.trim();
      break;
    }

    case "ads_google": {
      const {
        objective = "vente en ligne de produits africains",
        offer = "épicerie et plats africains livrés à Casablanca",
        url = siteUrl,
        audience = "personnes au Maroc cherchant des produits ou plats africains",
        variants = 5,
      } = payload;

      userPrompt = `
Tâche: Générer des assets pour Google Ads (Search / éventuellement Performance Max) pour ${brand}.
Objectif: ${objective}
Offre: ${offer}
Page de destination: ${url}
Audience: ${audience}

Délivre un JSON structuré:
{
  "keywords": ["mot clé 1", "mot clé 2"],
  "ads": [
    {
      "headlines": ["Titre 1 (max 30 caractères)", "Titre 2 (max 30 caractères)", "Titre 3 (max 30 caractères)"],
      "descriptions": ["Description 1 (max 90 caractères)", "Description 2 (max 90 caractères)"],
      "path": "epicerie-africaine",
      "final_url": "${url}"
    }
  ]
}
Respecte bien les limitations (30 caractères titres, 90 descriptions).
Répond STRICTEMENT en JSON valide, rien d'autre.
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
Tâche: Répondre à un message WhatsApp d'un client du service ${brand}.
Message du client:
"""${message}"""

Contexte: ${context}
Langue: ${language}

Contraintes:
- Réponse courte (1 à 4 phrases max).
- Proposer une action claire (ex: envoyer localisation, visiter ${siteUrl}, préciser quartier, valider commande, etc.).
- Style chaleureux, précis, rassurant.

Réponds uniquement avec le texte du message à envoyer sur WhatsApp, sans guillemets, sans JSON.
`.trim();
      break;
    }

    default:
      throw new Error(`Task type non supporté: ${taskType}`);
  }

  const completion = await openai.chat.completions.create({
    model: pickModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: pickTemp(),
    max_tokens: pickMaxTokens(),
  });

  const content = completion?.choices?.[0]?.message?.content || "";

  if (taskType === "whatsapp_reply") {
    return String(content).trim();
  }

  const parsed = extractJsonLoose(content);
  if (parsed) return parsed;

  return { raw: String(content) };
}

module.exports = { runDuuminiAgent };
