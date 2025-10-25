const { verifyAccess } = require("../../utils/jwt");

function extractToken(req) {
  const h = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  const x = String(req.headers["x-access-token"] || "");
  if (x) return x.trim();
  if (req.query?.access_token) return String(req.query.access_token).trim();
  return null;
}

function attachUser(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  const p = verifyAccess(token);
  req.user = { id: p.id, uid: p.uid ?? String(p.id ?? ""), role: p.role || "MEMBER" };
}

function authRequired(req, res, next) {
  try { if (req.method === "OPTIONS") return next(); attachUser(req); next(); }
  catch (e) { res.status(e.status || 401).json({ error: "Unauthorized" }); }
}

function optionalAuth(req, _res, next) {
  try { if (req.method === "OPTIONS") return next(); const t = extractToken(req); if (t) attachUser(req); } finally { next(); }
}

function requireRole(...roles) {
  const allowed = roles.map(r => String(r).toUpperCase());
  return (req, res, next) => {
    try {
      if (!req.user) attachUser(req);
      const role = String(req.user?.role || "").toUpperCase();
      if (allowed.length && !allowed.includes(role)) return res.status(403).json({ error: "Forbidden" });
      next();
    } catch { res.status(401).json({ error: "Unauthorized" }); }
  };
}

const isAdmin  = (u) => String(u?.role).toUpperCase() === "ADMIN";
const isVendor = (u) => String(u?.role).toUpperCase() === "VENDEUR";

module.exports = { authRequired, optionalAuth, requireRole, isAdmin, isVendor };
