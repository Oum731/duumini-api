const webpush = require("web-push");
const { env } = require("../config/env");
const { PushSubscription } = require("../models");

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (env.vapid.publicKey && env.vapid.privateKey) {
    webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  }
  configured = true;
}

/**
 * Envoie une notification push à tout le monde SAUF l'auteur de l'action.
 */
async function notifyOthers(excludeUserId, payload) {
  ensureConfigured();
  if (!env.vapid.publicKey || !env.vapid.privateKey) return; // push non configuré

  const subs = await PushSubscription.findAll({ where: {} });
  const targets = subs.filter((s) => s.userId !== excludeUserId);

  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sub.destroy();
        } else {
          console.error("[duoline] Erreur push:", err.message);
        }
      }
    })
  );
}

module.exports = { notifyOthers };
