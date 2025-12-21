// src/routes/locations.js
const { Router } = require("express");
const { getPool } = require("../lib/db");

const router = Router();

/* =========================
 * Utils
 * ========================= */
function norm(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function normSpaces(s) {
  const x = norm(s);
  return x ? x.replace(/\s+/g, " ") : null;
}

function normCity(v) {
  return normSpaces(v);
}
function normCommune(v) {
  return normSpaces(v);
}
function normQuartier(v) {
  return normSpaces(v);
}

function pickQuery(req, ...keys) {
  for (const k of keys) {
    const v = req.query?.[k];
    const n = norm(v);
    if (n) return n;
  }
  return null;
}

function pickBody(req, ...keys) {
  for (const k of keys) {
    const v = req.body?.[k];
    const n = norm(v);
    if (n) return n;
  }
  return null;
}

function qLike(req) {
  const q = String(req.query.q || "").trim().toLowerCase();
  return q ? q : "";
}

function parseLimit(req, def, min, max) {
  const raw = req.query.limit;
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function wantCount(req) {
  const v = String(req.query.withCount || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function sortFr(a, b) {
  return String(a).localeCompare(String(b), "fr");
}

function mergeUniqueStrings(rowsA, rowsB, normalizer) {
  const map = new Map();
  for (const r of [...rowsA, ...rowsB]) {
    const name = normalizer(r?.name);
    if (!name) continue;
    map.set(name.toLowerCase(), name);
  }
  return Array.from(map.values()).sort(sortFr);
}

function mergeWithCounts(rowsA, rowsB, normalizer) {
  // rows: { name, cnt }
  const map = new Map(); // keyLower -> { value, count }
  const push = (r) => {
    const name = normalizer(r?.name);
    if (!name) return;
    const key = name.toLowerCase();
    const cnt = Number(r?.cnt || 0) || 0;
    const cur = map.get(key);
    if (!cur) map.set(key, { value: name, count: cnt });
    else map.set(key, { value: cur.value, count: (cur.count || 0) + cnt });
  };
  for (const r of rowsA) push(r);
  for (const r of rowsB) push(r);

  return Array.from(map.values())
    .sort((x, y) => sortFr(x.value, y.value))
    .map((x) => ({ value: x.value, count: x.count || 0 }));
}

/* =========================
 * GET /api/locations/cities
 * q=...&limit=...&withCount=1
 * ========================= */
router.get("/cities", async (req, res) => {
  const q = qLike(req);
  const limit = parseLimit(req, 500, 1, 1000);
  const withCount = wantCount(req);
  const pool = getPool();

  try {
    if (withCount) {
      // suggestions
      const [a] = await pool.query(
        `
        SELECT city AS name, COUNT(*) AS cnt
        FROM location_suggestions
        WHERE city IS NOT NULL AND city <> ''
        GROUP BY city
        ORDER BY city ASC
        LIMIT ?
        `,
        [limit]
      );

      // users
      const [b] = await pool.query(
        `
        SELECT ville AS name, COUNT(*) AS cnt
        FROM users
        WHERE ville IS NOT NULL AND ville <> ''
        GROUP BY ville
        ORDER BY ville ASC
        LIMIT ?
        `,
        [limit]
      );

      let items = mergeWithCounts(a, b, normCity);
      if (q) items = items.filter((x) => x.value.toLowerCase().includes(q));
      return res.json({ items });
    }

    const [a] = await pool.query(
      `
      SELECT DISTINCT city AS name
      FROM location_suggestions
      WHERE city IS NOT NULL AND city <> ''
      ORDER BY city ASC
      LIMIT ?
      `,
      [limit]
    );

    const [b] = await pool.query(
      `
      SELECT DISTINCT ville AS name
      FROM users
      WHERE ville IS NOT NULL AND ville <> ''
      ORDER BY ville ASC
      LIMIT ?
      `,
      [limit]
    );

    let items = mergeUniqueStrings(a, b, normCity);
    if (q) items = items.filter((x) => x.toLowerCase().includes(q));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/locations/cities
 * body: { city } (ou { ville })
 * ========================= */
router.post("/cities", async (req, res) => {
  const city = normCity(pickBody(req, "city", "ville"));
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

/* =========================
 * GET /api/locations/communes?city=... (ou ville=...)
 * q=...&limit=...&withCount=1
 * ========================= */
router.get("/communes", async (req, res) => {
  const city = normCity(pickQuery(req, "city", "ville"));
  if (!city) return res.status(400).json({ error: "city required" });

  const q = qLike(req);
  const limit = parseLimit(req, 800, 1, 2000);
  const withCount = wantCount(req);

  const pool = getPool();
  try {
    if (withCount) {
      const [a] = await pool.query(
        `
        SELECT commune AS name, COUNT(*) AS cnt
        FROM location_suggestions
        WHERE city=? AND commune IS NOT NULL AND commune <> ''
        GROUP BY commune
        ORDER BY commune ASC
        LIMIT ?
        `,
        [city, limit]
      );

      const [b] = await pool.query(
        `
        SELECT commune AS name, COUNT(*) AS cnt
        FROM users
        WHERE ville=? AND commune IS NOT NULL AND commune <> ''
        GROUP BY commune
        ORDER BY commune ASC
        LIMIT ?
        `,
        [city, limit]
      );

      let items = mergeWithCounts(a, b, normCommune);
      if (q) items = items.filter((x) => x.value.toLowerCase().includes(q));
      return res.json({ items });
    }

    const [a] = await pool.query(
      `
      SELECT DISTINCT commune AS name
      FROM location_suggestions
      WHERE city=? AND commune IS NOT NULL AND commune <> ''
      ORDER BY commune ASC
      LIMIT ?
      `,
      [city, limit]
    );

    const [b] = await pool.query(
      `
      SELECT DISTINCT commune AS name
      FROM users
      WHERE ville=? AND commune IS NOT NULL AND commune <> ''
      ORDER BY commune ASC
      LIMIT ?
      `,
      [city, limit]
    );

    let items = mergeUniqueStrings(a, b, normCommune);
    if (q) items = items.filter((x) => x.toLowerCase().includes(q));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/locations/communes
 * body: { city/ville, commune }
 * ========================= */
router.post("/communes", async (req, res) => {
  const city = normCity(pickBody(req, "city", "ville"));
  const commune = normCommune(pickBody(req, "commune"));
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

/* =========================
 * GET /api/locations/quartiers?city=...&commune=...
 * (ou ville=...&commune=...)
 * q=...&limit=...&withCount=1
 * ========================= */
router.get("/quartiers", async (req, res) => {
  const city = normCity(pickQuery(req, "city", "ville"));
  const commune = normCommune(pickQuery(req, "commune"));
  if (!city) return res.status(400).json({ error: "city required" });
  if (!commune) return res.status(400).json({ error: "commune required" });

  const q = qLike(req);
  const limit = parseLimit(req, 1200, 1, 3000);
  const withCount = wantCount(req);

  const pool = getPool();
  try {
    if (withCount) {
      const [a] = await pool.query(
        `
        SELECT quartier AS name, COUNT(*) AS cnt
        FROM location_suggestions
        WHERE city=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
        GROUP BY quartier
        ORDER BY quartier ASC
        LIMIT ?
        `,
        [city, commune, limit]
      );

      const [b] = await pool.query(
        `
        SELECT quartier AS name, COUNT(*) AS cnt
        FROM users
        WHERE ville=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
        GROUP BY quartier
        ORDER BY quartier ASC
        LIMIT ?
        `,
        [city, commune, limit]
      );

      let items = mergeWithCounts(a, b, normQuartier);
      if (q) items = items.filter((x) => x.value.toLowerCase().includes(q));
      return res.json({ items });
    }

    const [a] = await pool.query(
      `
      SELECT DISTINCT quartier AS name
      FROM location_suggestions
      WHERE city=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
      ORDER BY quartier ASC
      LIMIT ?
      `,
      [city, commune, limit]
    );

    const [b] = await pool.query(
      `
      SELECT DISTINCT quartier AS name
      FROM users
      WHERE ville=? AND commune=? AND quartier IS NOT NULL AND quartier <> ''
      ORDER BY quartier ASC
      LIMIT ?
      `,
      [city, commune, limit]
    );

    let items = mergeUniqueStrings(a, b, normQuartier);
    if (q) items = items.filter((x) => x.toLowerCase().includes(q));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/locations/quartiers
 * body: { city/ville, commune, quartier }
 * ========================= */
router.post("/quartiers", async (req, res) => {
  const city = normCity(pickBody(req, "city", "ville"));
  const commune = normCommune(pickBody(req, "commune"));
  const quartier = normQuartier(pickBody(req, "quartier"));
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

/* =========================
 * POST /api/locations/track  ✅ PRO (best-effort)
 * body: { kind: 'VILLE'|'COMMUNE'|'QUARTIER', ville/city, commune, quartier }
 *
 * - VILLE    => upsert (city, NULL, NULL)
 * - COMMUNE  => upsert (city, commune, NULL)
 * - QUARTIER => upsert (city, commune?, quartier)
 * ========================= */
router.post("/track", async (req, res) => {
  const kindRaw = String(req.body?.kind || "").trim().toUpperCase();
  const kind = ["VILLE", "COMMUNE", "QUARTIER"].includes(kindRaw) ? kindRaw : null;

  const city = normCity(pickBody(req, "city", "ville"));
  const commune = normCommune(pickBody(req, "commune"));
  const quartier = normQuartier(pickBody(req, "quartier"));

  if (!kind) return res.status(400).json({ error: "kind required" });
  if (!city) return res.status(400).json({ error: "city required" });

  const pool = getPool();

  try {
    if (kind === "VILLE") {
      await pool.query(
        `
        INSERT INTO location_suggestions (city, commune, quartier)
        VALUES (?, NULL, NULL)
        ON DUPLICATE KEY UPDATE city = VALUES(city)
        `,
        [city]
      );
      return res.json({ ok: true });
    }

    if (kind === "COMMUNE") {
      if (!commune) return res.status(400).json({ error: "commune required" });
      await pool.query(
        `
        INSERT INTO location_suggestions (city, commune, quartier)
        VALUES (?, ?, NULL)
        ON DUPLICATE KEY UPDATE city = VALUES(city)
        `,
        [city, commune]
      );
      return res.json({ ok: true });
    }

    // QUARTIER
    if (!quartier) return res.status(400).json({ error: "quartier required" });

    // commune peut être null (si invité a tapé une adresse libre), on la laisse NULL
    await pool.query(
      `
      INSERT INTO location_suggestions (city, commune, quartier)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE city = VALUES(city)
      `,
      [city, commune || null, quartier]
    );

    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
