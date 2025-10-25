const { getPool } = require("../lib/db");
const { notifyUser, setIO } = require("../services/notify");
const { env } = require("../lib/env");

let timer = null;

async function tick() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, user_id, type, payload
     FROM notification_queue
     WHERE status = 'queued'
     ORDER BY id ASC
     LIMIT 20`
  );

  for (const n of rows) {
    try {
      const payload = typeof n.payload === "string" ? JSON.parse(n.payload) : n.payload;
      const title = payload?.title || "Duumini";
      const body = payload?.body || "";
      const res = await notifyUser(n.user_id, n.type, payload, { title, body });

      await pool.query(
        "UPDATE notification_queue SET status = ?, sent_at = NOW(), attempts = attempts + 1 WHERE id = ?",
        [res.push || res.ws ? "sent" : "failed", n.id]
      );
    } catch (e) {
      await pool.query(
        "UPDATE notification_queue SET status = ?, error_text = ?, attempts = attempts + 1 WHERE id = ?",
        ["failed", String(e).slice(0, 500), n.id]
      );
    }
  }
}

function startNotificationWorker(io) {
  setIO(io);
  if (!env.LISTENERS_ENABLED) {
    console.log("[NotifyWorker] Disabled (LISTENERS_ENABLED=false)");
    return;
  }
  const every = Math.max(2000, env.POLL_INTERVAL_MS || 10000);
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), every);
  console.log("[NotifyWorker] Started, interval =", every, "ms");
}

module.exports = { startNotificationWorker };
