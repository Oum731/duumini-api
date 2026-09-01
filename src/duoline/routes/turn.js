const { Router } = require("express");
const { env } = require("../config/env");
const { requireAuth } = require("../middleware/auth");

const turnRouter = Router();

const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, iceServers: null };

async function fetchMeteredIceServers() {
  if (!env.ice.meteredEndpoint || !env.ice.meteredApiKey) return null;

  if (cache.iceServers && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.iceServers;
  }

  const url = `${env.ice.meteredEndpoint}?apiKey=${encodeURIComponent(env.ice.meteredApiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Metered ${response.status}`);
    const iceServers = await response.json();
    if (!Array.isArray(iceServers) || iceServers.length === 0) throw new Error("Réponse Metered vide");

    cache = { at: Date.now(), iceServers };
    return iceServers;
  } catch (err) {
    console.error("[duoline] Metered TURN indisponible, repli statique:", err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function staticIceServers() {
  const servers = [...STUN_ONLY];
  if (env.ice.turnUrl) {
    servers.push({
      urls: env.ice.turnUrl,
      username: env.ice.turnUsername,
      credential: env.ice.turnCredential,
    });
  }
  return servers;
}

turnRouter.get("/", requireAuth, async (req, res) => {
  if (env.ice.mode !== "turn") {
    return res.json({ iceServers: STUN_ONLY });
  }

  const iceServers = (await fetchMeteredIceServers()) || staticIceServers();
  res.json({ iceServers });
});

module.exports = { turnRouter };
