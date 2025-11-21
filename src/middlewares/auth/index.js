// src/middlewares/auth/index.js
const { verifyAccess } = require("../../utils/jwt");
const { getPool } = require("../../lib/db");

/**
 * On autorise le token en query string UNIQUEMENT
 * pour certaines routes (comme SSE /api/events/stream).
 */
const ALLOW_QUERY_TOKEN_PATHS = ["/api/events/stream"];

function extractToken(req) {
  // 1) Authorization: Bearer <token>
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }

  // 2) x-access-token (fallback header interne)
  const x = req.headers["x-access-token"];
  if (typeof x === "string" && x.trim()) return x.trim();

  // 3) (optionnel) query ?access_token= (seulement pour certaines routes)
  const path = req.path || req.originalUrl || "";
  if (
    req.query &&
    req.query.access_token &&
    ALLOW_QUERY_TOKEN_PATHS.includes(path)
  ) {
    return String(req.query.access_token).trim();
  }

  return null;
}

async function attachUserOrThrow(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error("No token");
    err.status = 401;
    throw err;
  }

  let payload;
  try {
    payload = verifyAccess(token); // throw si invalide/expiré
  } catch {
    const err = new Error("Invalid token");
    err.status = 401;
    throw err;
  }

  // ✅ DB = source de vérité : relire le rôle courant
  const id = payload.id ?? payload.sub ?? payload.user_id;
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, phone, role FROM users WHERE id=? LIMIT 1",
    [id]
  );
  const u = rows && rows[0];
  if (!u) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  req.user = { id: u.id, uid: String(u.id), role: String(u.role) };
}

async function authRequired(req, res, next) {
  if (req.method === "OPTIONS") return next();
  try {
    await attachUserOrThrow(req);
    return next();
  } catch (e) {
    const status = e?.status || 401;
    return res.status(status).json({ error: e?.message || "Unauthorized" });
  }
}

async function optionalAuth(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  try {
    const token = extractToken(req);
    if (token) await attachUserOrThrow(req);
  } catch {
    // silencieux : le handler aval décidera
  } finally {
    return next();
  }
}

function requireRole(...roles) {
  const allowed = roles.map((r) => String(r).toUpperCase());
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      if (!req.user) await attachUserOrThrow(req);
      const role = String(req.user?.role || "").toUpperCase();
      if (allowed.length && !allowed.includes(role)) {
        return res
          .status(403)
          .json({ error: `Forbidden: requires role ${allowed.join(" or ")}` });
      }
      return next();
    } catch (e) {
      const status = e?.status || 401;
      return res.status(status).json({ error: e?.message || "Unauthorized" });
    }
  };
}

const isAdmin  = (u) => String(u?.role).toUpperCase() === "ADMIN";
const isVendor = (u) => String(u?.role).toUpperCase() === "VENDEUR";

module.exports = { authRequired, optionalAuth, requireRole, isAdmin, isVendor };
