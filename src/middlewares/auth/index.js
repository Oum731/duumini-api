// src/middlewares/auth/index.js
const { verifyAccess } = require("../../utils/jwt");

/** Active (true) uniquement si tu DOIS supporter ?access_token=... */
const ALLOW_QUERY_TOKEN = false;

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

  // 3) (optionnel) query ?access_token=
  if (ALLOW_QUERY_TOKEN && req.query && req.query.access_token) {
    return String(req.query.access_token).trim();
  }

  return null;
}

function attachUserOrThrow(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error("No token");
    err.status = 401;
    throw err;
  }
  let payload;
  try {
    payload = verifyAccess(token); // doit throw si invalide/expiré
  } catch (e) {
    const err = new Error("Invalid token");
    err.status = 401;
    throw err;
  }
  // Normalisation user
  const id = payload.id ?? payload.sub ?? payload.user_id;
  req.user = {
    id,
    uid: payload.uid ?? String(id ?? ""),
    role: (payload.role || "MEMBER").toString(),
  };
}

function authRequired(req, res, next) {
  // Toujours laisser passer les preflight CORS
  if (req.method === "OPTIONS") return next();
  try {
    attachUserOrThrow(req);
    return next();
  } catch (e) {
    const status = e?.status || 401;
    return res.status(status).json({ error: e?.message || "Unauthorized" });
  }
}

function optionalAuth(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  try {
    const token = extractToken(req);
    if (token) attachUserOrThrow(req);
  } catch {
    // silencieux: on n'écrase pas la requête si le token est invalide
    // le handler en aval décidera s'il faut 401/403
  } finally {
    return next();
  }
}

function requireRole(...roles) {
  const allowed = roles.map((r) => String(r).toUpperCase());
  return (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      if (!req.user) attachUserOrThrow(req); // s'assure qu'on a req.user
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
module.exports = require('./auth');
