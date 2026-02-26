// src/routes/geo.js
const { Router } = require("express");

const router = Router();

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

router.get("/ip", async (req, res) => {
  try {
    const ip = getClientIp(req);

    // ✅ Node 20: fetch est global (pas besoin de node-fetch)
    const r = await globalThis.fetch("https://ipapi.co/json/", {
      headers: { Accept: "application/json" },
    });

    const data = await r.json();

    return res.json({
      ip: ip || null,
      city: data?.city || null,
      region: data?.region || null,
      country: data?.country_name || null,
      source: "ip",
    });
  } catch (e) {
    return res.json({ city: null, source: "unknown" });
  }
});

module.exports = router;