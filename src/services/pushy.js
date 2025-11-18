// src/services/pushy.js
const axios = require("axios");
const { env } = require("../lib/env");

/**
 * Envoie une notification Pushy.
 *
 * @param {string[]} toTokens  Liste de tokens Pushy
 * @param {object}   data      Payload data (data-only)
 * @param {object?}  notification { title, body, badge? }
 */
async function sendPush(toTokens = [], data = {}, notification = null) {
  if (!env.PUSHY_API_KEY) {
    console.error("[Pushy] Missing PUSHY_API_KEY");
    throw new Error("Missing PUSHY_API_KEY");
  }

  const body = { to: toTokens, data };
  if (notification) {
    body.notification = notification; // { title, body, badge? }
  }

  const res = await axios.post("https://api.pushy.me/push", body, {
    params: { api_key: env.PUSHY_API_KEY },
    timeout: 10000,
  });

  return res.data;
}

module.exports = { sendPush };
