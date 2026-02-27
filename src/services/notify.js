// src/services/notify.js
const { getPool } = require("../lib/db");
const { sendPush } = require("./pushy");

let ioRef = null;

/**
 * Injecte l'instance Socket.IO (appelé depuis server.js / worker)
 */
function setIO(io) {
  ioRef = io || null;
}

/**
 * Envoie un event WS à un user
 * ✅ Retourne true seulement si l'émission a été tentée sans erreur
 */
function wsToUser(userId, event, payload) {
  if (!ioRef) return false;

  try {
    // Compat: si attachSocket a défini broadcastToUser, on l'utilise
    if (typeof ioRef.broadcastToUser === "function") {
      ioRef.broadcastToUser(userId, event, payload);
      return true;
    }

    // Fallback standard Socket.IO (rooms)
    ioRef.to(`user:${userId}`).emit(event, payload);
    return true;
  } catch (e) {
    console.error("[WS] wsToUser error:", e?.message || e);
    return false;
  }
}

/**
 * Récupère la liste des tokens push d'un user
 */
async function getUserPushTokens(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const [rows] = await getPool().query(
    "SELECT push_token, provider FROM user_devices WHERE user_id = ?",
    [uid],
  );

  return (rows || [])
    .map((r) => ({
      token: r?.push_token ? String(r.push_token) : "",
      provider: r?.provider ? String(r.provider).toLowerCase() : "",
    }))
    .filter((t) => t.token);
}

/**
 * Envoie une notification push (Pushy) à un user
 */
async function pushToUser(userId, payload, notification = null) {
  const tokens = await getUserPushTokens(userId);

  const pushyTokens = tokens
    .filter((t) => t.provider === "pushy")
    .map((t) => t.token);

  if (pushyTokens.length === 0) {
    return { ok: false, reason: "no_device" };
  }

  const data = { type: payload?.type || "GENERIC", payload };

  try {
    const res = await sendPush(pushyTokens, data, notification);
    return { ok: true, res };
  } catch (e) {
    console.error("[Push] Error sending push:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * notifyUser :
 *  - envoie un event WS "notify" à l'utilisateur
 *  - en option (par défaut) envoie aussi une push via Pushy
 *
 * ✅ IMPORTANT: retourne ws:true seulement si WS a réellement été émis sans erreur
 */
async function notifyUser(userId, type, payload, opts = {}) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const body = { type, ...safePayload };

  // WS temps réel
  const wsOk = wsToUser(userId, "notify", body);

  // Push désactivée explicitement ?
  if (opts && opts.push === false) {
    return { ws: wsOk, push: false };
  }

  // Push Pushy
  const title = (opts && opts.title) || safePayload.title || "Notification";
  const bodyText = (opts && opts.body) || safePayload.body || "";

  // Si notif vide, on peut quand même envoyer du "data-only" (selon ton sendPush)
  const notif = title || bodyText ? { title, body: bodyText } : null;

  const r = await pushToUser(userId, { type, ...safePayload }, notif);
  return { ws: wsOk, push: r.ok, pushInfo: r };
}

module.exports = { setIO, notifyUser };