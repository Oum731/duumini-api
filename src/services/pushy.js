const axios = require("axios");
const { env } = require("../lib/env");

async function sendPush(toTokens = [], data = {}, notification = null) {
  if (!env.PUSHY_API_KEY) return { ok: false, error: "Missing PUSHY_API_KEY" };
  const body = { to: toTokens, data };
  if (notification) body.notification = notification; // { title, body, badge }
  const res = await axios.post("https://api.pushy.me/push", body, {
    params: { api_key: env.PUSHY_API_KEY },
    timeout: 10000,
  });
  return res.data;
}

module.exports = { sendPush };
