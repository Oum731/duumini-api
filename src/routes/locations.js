// src/routes/locations.js
const { Router } = require("express");
const { getPool } = require("../lib/db");

const router = Router();

function norm(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function normCity(v) {
  const s = norm(v);
  return s ? s.replace(/\s+/g, " ") : null;
}
function normCommune(v) {
  const s = norm(v);
  return s ? s.replace(/\s+/g, " ") : null;
}
function normQuartier(v) {
  const s = norm(v);
  return s ? s.replace(/\s+/g, " ") : null;
}

/**
 * GET /api/locations/cities
 * -> liste villes (suggestions + users)
 */
router.get("/cities", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const pool = getPool();

  try {
    // 1) depuis suggestions
    const [a] = await pool.query(
      `
      SELECT DISTINCT city AS name
      FROM location_suggestions
      WHERE city IS NOT NULL AND city <> ''
      ORDER BY city ASC
      LIMIT 500
      `
    );

    // 2) depuis users (fallback/complément)
    const [b] = await pool.query(
      `
      SELECT DISTINCT ville AS name
      FROM users
      WHERE ville IS NOT NULL AND ville <> ''
      ORDER BY ville ASC
      LIMIT 500
      `
    );

    const map = new Map();
    for (const r of [...a, ...b]) {
      const name = normCity(r?.name);
      if (!name) continue;
      map.set(name.toLowerCase(), name);
    }

    let items = Array.from(map.values()).sort((x, y) => x.localeCompare(y, "fr"));
    if (q) items = items.filter((x) => x.toLowerCase().includes(q));

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/locations/cities
 * body: { city }
 */
router.post("/cities", async (req, res) => {
  const city = normCity(req.body?.city);
  if (!city) return res.status(400).json({ error: "city required" });

  const pool = getPool();
  try {
    await pool.query(
      `
      INSERT INTO location_suggestions (city, commune, quartier)
      VALUES (?, NULL, NULL)
      ON DUPLICATE KEY UPDATE city = VALUES(city)
      `,
      [city]
    );
    res.status(201).json({ ok: true, city });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/locations/communes?city=
 */
router.get("/communes", async (req, res) => {
  const city = normCity(req.query.city);
  if (!city) return res.status(400).json({ error: "city required" });

  const pool = getPool();
  try {
    const [a] = await pool.query(
      `
      SELECT DISTINCT commune AS name
      FROM location_suggestions
      WHERE city=? AND commune IS NOT NULL AND commune <> ''
      ORDER BY commune ASC
      LIMIT 800
      `,
      [city]
    );

    const [b] = await pool.query(
      `
      SELECT DISTINCT commune AS name
      FROM users
      WHERE ville=? AND commune IS NOT NULL AND commune <> ''
      ORDER BY commune ASC
      LIMIT 800
      `,
      [city]
    );

    const map = new Map();
    for (const r of [...a, ...b]) {
      const name = normCommune(r?.name);
      if (!name) continue;
      map.set(name.toLowerCase(), name);
    }

    const items = Array.from(map.values()).sort((x, y) => x.localeCompare(y, "fr"));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/locations/communes
 * body: { city, commune }
 */
router.post("/communes", async (req, res) => {
  const city = normCity(req.body?.city);
  const commune = normCommune(req.body?.commune);
  if (!city) return res.status(400).json({ error: "city required" });
  if (!commune) return res.status(400).json({ error: "commune required" });

  const pool = getPool();
  try {
    await pool.query(
      `
      INSERT INTO location_suggestions (city, commune, quartier)
      VALUES (?, ?, NULL)
      ON DUPLICATE KEY UPDATE city = VALUES(city)
      `,
      [city, commune]
    );
    res.status(201).json({ ok: true, city, commune });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/locations/quartiers?city=&commune=
 */
router.get("/quartiers", async (req, res) => {
  const city = normCity(req.query.city);
  const commune = normCommune(req.query.commune);
  if (!city) return res.status(400).json({ error: "city required" });
  if (!commune) return res.status(400).json({ error: "commune required" });

  const pool = getPool();
  try {
    const [a] = await pool.query(
      `
      SELECT DISTINCT quartier AS name
      FROM location_suggestions
      WHERE city=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
      ORDER BY quartier ASC
      LIMIT 1200
      `,
      [city, commune]
    );

    const [b] = await pool.query(
      `
      SELECT DISTINCT quartier AS name
      FROM users
      WHERE ville=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
      ORDER BY quartier ASC
      LIMIT 1200
      `,
      [city, commune]
    );

    const map = new Map();
    for (const r of [...a, ...b]) {
      const name = normQuartier(r?.name);
      if (!name) continue;
      map.set(name.toLowerCase(), name);
    }

    const items = Array.from(map.values()).sort((x, y) => x.localeCompare(y, "fr"));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/locations/quartiers
 * body: { city, commune, quartier }
 */
router.post("/quartiers", async (req, res) => {
  const city = normCity(req.body?.city);
  const commune = normCommune(req.body?.commune);
  const quartier = normQuartier(req.body?.quartier);
  if (!city) return res.status(400).json({ error: "city required" });
  if (!commune) return res.status(400).json({ error: "commune required" });
  if (!quartier) return res.status(400).json({ error: "quartier required" });

  const pool = getPool();
  try {
    await pool.query(
      `
      INSERT INTO location_suggestions (city, commune, quartier)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE city = VALUES(city)
      `,
      [city, commune, quartier]
    );
    res.status(201).json({ ok: true, city, commune, quartier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
