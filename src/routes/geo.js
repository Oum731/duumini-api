// api/routes/geo.js
const { Router } = require("express");
const fetch = require("node-fetch");

const router = Router();

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

router.get("/ip", async (req, res) => {
  try {
    const ip = getClientIp(req);

    // ⚠️ certains providers n'acceptent pas IPv6 local ::1 etc.
    // On peut aussi laisser le provider déduire l'IP sans la passer.
    const r = await fetch("https://ipapi.co/json/", {
      headers: { Accept: "application/json" },
    });

    const data = await r.json();

    // ex: data.city, data.region, data.country_name
    return res.json({
      city: data?.city || null,
      region: data?.region || null,
      country: data?.country_name || null,
      source: "ip",
      ip: ip || null,
    });
  } catch (e) {
    return res.json({ city: null, source: "unknown" });
  }
});

module.exports = router;