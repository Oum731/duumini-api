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

function toTitleCase(s) {
  const x = normSpaces(s);
  if (!x) return null;
  return x
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

/**
 * ✅ Sécurité: refuser HTML/tags + chars invisibles
 * ✅ Whitelist: lettres (accents), chiffres, espaces, ' . -
 * ✅ Longueur: 2..40 (ajuste si besoin)
 */
function isSafeLabel(s, { min = 2, max = 40 } = {}) {
  const x = normSpaces(s);
  if (!x) return false;

  if (x.length < min || x.length > max) return false;

  // HTML / tags
  if (/[<>]/.test(x)) return false;

  // caractères de contrôle / invisibles
  if (/[\u0000-\u001F\u007F]/.test(x)) return false;

  // blacklist simple (optionnel, mais utile)
  const low = x.toLowerCase();
  if (low.includes("script") || low.includes("onerror") || low.includes("onload")) return false;

  // whitelist caractères
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s'.-]+$/.test(x)) return false;

  return true;
}

/**
 * ✅ Normalise + valide un champ (city/commune/quartier)
 * - titre case (Mohammedia, Ain Sebaa…)
 * - renvoie null si invalide
 */
function sanitizePlaceLabel(v, opts) {
  const t = toTitleCase(v);
  if (!t) return null;
  if (!isSafeLabel(t, opts)) return null;
  return t;
}

function normCity(v) {
  return sanitizePlaceLabel(v, { min: 2, max: 40 });
}
function normCommune(v) {
  return sanitizePlaceLabel(v, { min: 2, max: 60 });
}
function normQuartier(v) {
  return sanitizePlaceLabel(v, { min: 1, max: 80 });
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

/** ✅ filtre sécurité au moment du GET (si DB polluée) */
function safeList(list, normalizer) {
  const out = [];
  for (const raw of list) {
    const v = normalizer(raw);
    if (!v) continue;
    out.push(v);
  }
  return out;
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

      let items = mergeWithCounts(a, b, normCity); // ✅ filtre ici
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

    let items = mergeUniqueStrings(a, b, normCity); // ✅ filtre ici
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
  const raw = pickBody(req, "city", "ville");
  const city = normCity(raw);

  if (!raw) return res.status(400).json({ error: "city required" });
  if (!city) return res.status(400).json({ error: "invalid city" });

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
  const cityRaw = pickQuery(req, "city", "ville");
  const city = normCity(cityRaw);
  if (!cityRaw) return res.status(400).json({ error: "city required" });
  if (!city) return res.status(400).json({ error: "invalid city" });

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
  const cityRaw = pickBody(req, "city", "ville");
  const communeRaw = pickBody(req, "commune");

  const city = normCity(cityRaw);
  const commune = normCommune(communeRaw);

  if (!cityRaw) return res.status(400).json({ error: "city required" });
  if (!communeRaw) return res.status(400).json({ error: "commune required" });
  if (!city) return res.status(400).json({ error: "invalid city" });
  if (!commune) return res.status(400).json({ error: "invalid commune" });

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
  const cityRaw = pickQuery(req, "city", "ville");
  const communeRaw = pickQuery(req, "commune");

  const city = normCity(cityRaw);
  const commune = normCommune(communeRaw);

  if (!cityRaw) return res.status(400).json({ error: "city required" });
  if (!communeRaw) return res.status(400).json({ error: "commune required" });
  if (!city) return res.status(400).json({ error: "invalid city" });
  if (!commune) return res.status(400).json({ error: "invalid commune" });

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
  const cityRaw = pickBody(req, "city", "ville");
  const communeRaw = pickBody(req, "commune");
  const quartierRaw = pickBody(req, "quartier");

  const city = normCity(cityRaw);
  const commune = normCommune(communeRaw);
  const quartier = normQuartier(quartierRaw);

  if (!cityRaw) return res.status(400).json({ error: "city required" });
  if (!communeRaw) return res.status(400).json({ error: "commune required" });
  if (!quartierRaw) return res.status(400).json({ error: "quartier required" });

  if (!city) return res.status(400).json({ error: "invalid city" });
  if (!commune) return res.status(400).json({ error: "invalid commune" });
  if (!quartier) return res.status(400).json({ error: "invalid quartier" });

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
 * ========================= */
router.post("/track", async (req, res) => {
  const kindRaw = String(req.body?.kind || "").trim().toUpperCase();
  const kind = ["VILLE", "COMMUNE", "QUARTIER"].includes(kindRaw) ? kindRaw : null;

  const cityRaw = pickBody(req, "city", "ville");
  const communeRaw = pickBody(req, "commune");
  const quartierRaw = pickBody(req, "quartier");

  const city = normCity(cityRaw);
  const commune = normCommune(communeRaw);
  const quartier = normQuartier(quartierRaw);

  if (!kind) return res.status(400).json({ error: "kind required" });
  if (!cityRaw) return res.status(400).json({ error: "city required" });
  if (!city) return res.status(400).json({ error: "invalid city" });

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
      if (!communeRaw) return res.status(400).json({ error: "commune required" });
      if (!commune) return res.status(400).json({ error: "invalid commune" });

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
    if (!quartierRaw) return res.status(400).json({ error: "quartier required" });
    if (!quartier) return res.status(400).json({ error: "invalid quartier" });

    // commune peut être null (invité), mais si fourni on le valide
    const communeSafe = communeRaw ? commune : null;
    if (communeRaw && !communeSafe) return res.status(400).json({ error: "invalid commune" });

    await pool.query(
      `
      INSERT INTO location_suggestions (city, commune, quartier)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE city = VALUES(city)
      `,
      [city, communeSafe || null, quartier]
    );

    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
