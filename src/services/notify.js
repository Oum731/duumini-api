// src/services/notify.js
const { getPool } = require("../lib/db");
const { sendPush } = require("./pushy");

let ioRef = null;

/**
 * Injecte l'instance Socket.IO (appelé depuis server.js)
 */
function setIO(io) {
  ioRef = io;
}

/**
 * Envoie un event WS à un user
 */
function wsToUser(userId, event, payload) {
  if (!ioRef) return false;
  ioRef.broadcastToUser(userId, event, payload);
  return true;
}

/**
 * Récupère la liste des tokens push d'un user
 */
async function getUserPushTokens(userId) {
  const [rows] = await getPool().query(
    "SELECT push_token, provider FROM user_devices WHERE user_id = ?",
    [userId]
  );
  return rows.map((r) => ({ token: r.push_token, provider: r.provider }));
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

  const data = { type: payload.type || "GENERIC", payload };

  try {
    const res = await sendPush(pushyTokens, data, notification);
    return { ok: true, res };
  } catch (e) {
    console.error("[Push] Error sending push", e);
    return { ok: false, error: String(e) };
  }
}

/**
 * notifyUser :
 *  - envoie un event WS "notify" à l'utilisateur
 *  - en option (par défaut) envoie aussi une push via Pushy
 */
async function notifyUser(userId, type, payload, opts = {}) {
  const body = { type, ...payload };

  // WS temps réel
  wsToUser(userId, "notify", body);

  // Push désactivée explicitement ?
  if (opts.push === false) {
    return { ws: true, push: false };
  }

  // Push Pushy
  const title = opts.title || payload.title || "Notification";
  const bodyText = opts.body || payload.body || "";
  const notif =
    title || bodyText
      ? { title, body: bodyText }
      : null;

  const r = await pushToUser(userId, { type, ...payload }, notif);
  return { ws: true, push: r.ok, pushInfo: r };
}

module.exports = { setIO, notifyUser };
