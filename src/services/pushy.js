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
    throw new Error("Missing PUSHY_API_KEY");
  }

  const tokens = Array.isArray(toTokens)
    ? toTokens.map((t) => String(t || "").trim()).filter(Boolean)
    : [];

  if (tokens.length === 0) {
    return { ok: false, reason: "no_tokens" };
  }

  const body = { to: tokens, data: data && typeof data === "object" ? data : {} };

  // Attach "notification" only if valid (avoid empty title/body)
  if (notification && typeof notification === "object") {
    const title = notification.title != null ? String(notification.title).trim() : "";
    const msg = notification.body != null ? String(notification.body).trim() : "";
    const badge =
      notification.badge != null && Number.isFinite(Number(notification.badge))
        ? Number(notification.badge)
        : undefined;

    if (title || msg) {
      body.notification = { title, body: msg };
      if (badge !== undefined) body.notification.badge = badge;
    }
  }

  try {
    const res = await axios.post("https://api.pushy.me/push", body, {
      params: { api_key: env.PUSHY_API_KEY },
      timeout: 10000,
      validateStatus: (s) => s >= 200 && s < 300, // treat non-2xx as error
    });

    return res.data;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const msg = e?.message || "Pushy request failed";

    const detail =
      data && typeof data === "object"
        ? JSON.stringify(data).slice(0, 800)
        : String(data || "").slice(0, 800);

    const err = new Error(
      `[Pushy] ${status ? `HTTP ${status} ` : ""}${msg}${detail ? ` :: ${detail}` : ""}`,
    );
    err.status = status || 500;
    throw err;
  }
}

module.exports = { sendPush };