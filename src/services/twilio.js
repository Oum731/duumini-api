// src/services/twilio.js
const twilio = require("twilio");
const { env } = require("../lib/env");

const DEV_MODE =
  String(env.NODE_ENV || process.env.NODE_ENV || "development").toLowerCase() !==
  "production";

const DEV_TEST_CODE =
  env.OTP_TEST_CODE || process.env.OTP_TEST_CODE || "000000";

// Numéro WhatsApp Twilio (ex: 'whatsapp:+14155238886' ou juste '+14155238886')
const WHATSAPP_FROM =
  env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_FROM || null;

let client = null;

if (!DEV_MODE) {
  if (
    env.TWILIO_API_KEY_SID &&
    env.TWILIO_API_KEY_SECRET &&
    env.TWILIO_ACCOUNT_SID
  ) {
    client = twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
      accountSid: env.TWILIO_ACCOUNT_SID,
    });
    console.log("[Twilio] Using API Key auth");
  } else if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    console.log("[Twilio] Using Account SID + Auth Token");
  } else {
    console.warn("[Twilio] No credentials configured");
  }
}

/* =========================
 * HELPERS
 * =======================*/

/**
 * Normalise un numéro en format WhatsApp Twilio:
 *   'whatsapp:+2126566....'
 */
function normalizeWhatsAppNumber(phone, defaultCountry = "+212") {
  if (!phone) throw new Error("Numéro WhatsApp manquant");

  let raw = String(phone).trim().replace(/\s+/g, "");

  // si déjà au format 'whatsapp:+212...', on laisse
  if (raw.startsWith("whatsapp:")) return raw;

  // si commence par '+', on garde
  if (!raw.startsWith("+")) {
    // on enlève les 0 au début et on préfixe le pays
    raw = raw.replace(/^0+/, "");
    raw = defaultCountry + raw;
  }

  return `whatsapp:${raw}`;
}

/**
 * Récupère le FROM WhatsApp Twilio au bon format.
 */
function getWhatsAppFrom() {
  if (!WHATSAPP_FROM) return null;
  const raw = String(WHATSAPP_FROM).trim();
  return raw.startsWith("whatsapp:") ? raw : `whatsapp:${raw}`;
}

/* =========================
 * OTP
 * =======================*/

async function sendOtpStart(phone, purpose = "signup") {
  if (DEV_MODE && DEV_TEST_CODE) {
    console.log(
      `[Twilio DEV] OTP simulé pour ${phone}: ${DEV_TEST_CODE} (purpose=${purpose})`
    );
    return { sid: "dev", status: "approved", to: phone, purpose };
  }

  if (!client || !env.TWILIO_VERIFY_SID) {
    throw new Error("Twilio Verify non configuré");
  }

  const res = await client.verify.v2
    .services(env.TWILIO_VERIFY_SID)
    .verifications.create({ to: phone, channel: "sms", locale: "fr" });

  return { sid: res.sid, status: res.status, to: res.to, purpose };
}

async function checkOtpCode(phone, code) {
  if (DEV_MODE && DEV_TEST_CODE && code === DEV_TEST_CODE) {
    return { status: "approved", valid: true };
  }

  if (!client || !env.TWILIO_VERIFY_SID) {
    throw new Error("Twilio Verify non configuré");
  }

  const res = await client.verify.v2
    .services(env.TWILIO_VERIFY_SID)
    .verificationChecks.create({ to: phone, code });

  return { status: res.status, valid: res.status === "approved" };
}

/* =========================
 * ENVOI WHATSAPP
 * =======================*/

/**
 * Envoie un message WhatsApp "brut" via Twilio.
 *
 * @param {string} to - numéro de destination (ex: '+2126...', 'whatsapp:+2126...')
 * @param {string} body - contenu du message (peut être vide si media-only)
 * @param {string|string[]} [mediaUrl] - URL(s) d'image(s) publique(s) (Cloudinary, etc.)
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function sendWhatsAppMessage(to, body, mediaUrl) {
  // Mode DEV : on log seulement, aucun envoi réel
  if (DEV_MODE) {
    console.log("[Twilio DEV][WHATSAPP] Message simulé:");
    console.log("  to      =", to);
    console.log("  body    =", body);
    if (mediaUrl) console.log("  mediaUrl =", mediaUrl);
    return { sid: "dev-whatsapp", status: "queued-dev" };
  }

  if (!client) throw new Error("Twilio client non initialisé");

  const from = getWhatsAppFrom();
  if (!from) throw new Error("TWILIO_WHATSAPP_FROM non configuré");

  const toWhatsApp = normalizeWhatsAppNumber(to);

  const payload = { from, to: toWhatsApp };

  if (body && String(body).trim().length > 0) {
    payload.body = body;
  }

  if (mediaUrl) {
    payload.mediaUrl = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl];
  }

  const res = await client.messages.create(payload);
  return { sid: res.sid, status: res.status };
}

/**
 * Helper pour notifier le BACKOFFICE d'une commande Duumini.
 * Ce n'est PAS un message client, mais un message interne.
 */
async function sendWhatsAppOrderConfirmation({
  to,
  name,
  orderId,
  displayCode, // optionnel, ex: "3FZ9"
  total,
  ville,
  commune,
  quartier,
  phone,
  details = "",
  imageUrl = null,
}) {
  const lines = [];

  lines.push("🧾 *Nouvelle commande Duumini*");

  if (displayCode && orderId) {
    lines.push(`• ID commande : ${displayCode} (#${orderId})`);
  } else if (displayCode) {
    lines.push(`• ID commande : ${displayCode}`);
  } else if (orderId) {
    lines.push(`• ID commande : #${orderId}`);
  }

  if (name) lines.push(`• Client : ${name}`);
  if (phone) lines.push(`• Téléphone : ${phone}`);
  if (typeof total !== "undefined") lines.push(`• Total : ${total} MAD`);

  lines.push("");

  lines.push("📍 *Adresse de livraison*");
  if (ville) lines.push(`• Ville : ${ville}`);
  if (commune) lines.push(`• Commune : ${commune}`);
  if (quartier) lines.push(`• Quartier : ${quartier}`);

  if (details) {
    lines.push("");
    lines.push("🛒 *Articles*");
    lines.push(details);
  }

  lines.push("");
  lines.push("Merci de traiter cette commande dans les plus brefs délais.");

  const body = lines.join("\n");
  return sendWhatsAppMessage(to, body, imageUrl || undefined);
}
/**
 * ✅ Envoie un reçu (PDF) au client via WhatsApp.
 * mediaUrl DOIT être une URL HTTPS publique (accessible sans auth).
 */
async function sendWhatsAppReceiptToClient({
  to,
  receiptNumber,
  displayCode,
  total,
  currency = "MAD",
  pdfUrl,
}) {
  const lines = [];

  lines.push("🧾 *Reçu Duumini*");
  if (receiptNumber) lines.push(`• Reçu : ${receiptNumber}`);
  if (displayCode) lines.push(`• Commande : ${displayCode}`);
  if (typeof total !== "undefined" && total !== null)
    lines.push(`• Total : ${Number(total || 0).toFixed(2)} ${String(currency || "MAD").toUpperCase()}`);

  lines.push("");
  lines.push("📎 Reçu en pièce jointe (PDF).");
  lines.push("Merci pour votre commande 🙏");

  const body = lines.join("\n");

  // ✅ Twilio WhatsApp: mediaUrl en tableau possible
  return sendWhatsAppMessage(to, body, pdfUrl);
}
module.exports = {
  sendOtpStart,
  checkOtpCode,
  sendWhatsAppMessage,
  sendWhatsAppOrderConfirmation,
  sendWhatsAppReceiptToClient, // ✅

};
