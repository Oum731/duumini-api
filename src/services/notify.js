const { getPool } = require("../lib/db");
const { sendPush } = require("./pushy");

let ioRef = null;
function setIO(io) { ioRef = io; }

function wsToUser(userId, event, payload) {
  if (!ioRef) return false;
  ioRef.broadcastToUser(userId, event, payload);
  return true;
}

async function getUserPushTokens(userId) {
  const [rows] = await getPool().query(
    "SELECT push_token, provider FROM user_devices WHERE user_id = ?",
    [userId]
  );
  return rows.map((r) => ({ token: r.push_token, provider: r.provider }));
}

async function pushToUser(userId, payload, notification = null) {
  const tokens = await getUserPushTokens(userId);
  const pushyTokens = tokens.filter(t => t.provider === "pushy").map(t => t.token);
  if (pushyTokens.length === 0) return { ok: false, reason: "no_device" };
  const data = { type: payload.type || "GENERIC", payload };
  const res = await sendPush(pushyTokens, data, notification);
  return { ok: true, res };
}

async function notifyUser(userId, type, payload, opts = {}) {
  const body = { type, ...payload };

  wsToUser(userId, "notify", body);

  if (opts.push !== false) {
    const title = opts.title || payload.title || "Notification";
    const bodyText = opts.body || payload.body || "";
    const notif = title || bodyText ? { title, body: bodyText } : null;
    try {
      const r = await pushToUser(userId, { type, ...payload }, notif);
      return { ws: true, push: r.ok };
    } catch (e) {
      return { ws: true, push: false, error: String(e) };
    }
  }
  return { ws: true, push: false };
}

module.exports = { setIO, notifyUser };
