// src/middlewares/auth/index.js
const { verifyAccess } = require("../../utils/jwt");
const { getPool } = require("../../lib/db");

/**
 * On autorise le token en query string UNIQUEMENT
 * pour la route SSE /api/events/stream (et équivalent).
 */
const ALLOW_QUERY_TOKEN_PATHS = ["/api/events/stream", "/events/stream"];

function extractToken(req) {
  // 1) Authorization: Bearer <token>
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }

  // 2) x-access-token (fallback header interne)
  const x = req.headers["x-access-token"];
  if (typeof x === "string" && x.trim()) return x.trim();

  // 3) query ?access_token= (autorisé seulement pour certaines routes)
  if (req.query && req.query.access_token) {
    const tokenFromQuery = String(req.query.access_token).trim();

    const baseUrl = req.baseUrl || "";
    const path = req.path || "";
    const fullPath = (baseUrl + path).split("?")[0];

    const ok = ALLOW_QUERY_TOKEN_PATHS.includes(fullPath);
    if (ok) return tokenFromQuery;
  }

  return null;
}

function toPosInt(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * ✅ Accès double rôle (ex. un livreur qui devient aussi commercial) :
 * l'accès aux espaces livreur/commercial ne se base plus uniquement sur
 * `users.role` (une seule valeur) mais aussi sur la présence d'une ligne
 * de profil dans la table dédiée — les deux peuvent coexister pour un
 * même user_id, `users.role` reste juste le "rôle principal" affiché.
 * Utilisé à la fois par attachUserOrThrow (requêtes authentifiées) et par
 * le login (pour renvoyer les flags dès la connexion).
 */
async function getProfileFlags(pool, userId) {
  const [[lp]] = await pool.query(
    "SELECT 1 x FROM livreur_profiles WHERE user_id=? LIMIT 1",
    [userId]
  );
  const [[cp]] = await pool.query(
    "SELECT 1 x FROM commercial_profiles WHERE user_id=? LIMIT 1",
    [userId]
  );
  return { has_livreur_profile: !!lp, has_commercial_profile: !!cp };
}

/**
 * ✅ Impersonation support (robuste)
 * - payload peut contenir: actor_admin_id, impersonate_shop_id, impersonate_user_id
 * - DB = source de vérité pour role du "vrai" token owner (admin/user)
 * - effective_user_id/effective_role/effective_shop_id = qui agit réellement
 */
async function attachUserOrThrow(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error("No token");
    err.status = 401;
    throw err;
  }

  let payload;
  try {
    payload = verifyAccess(token);
  } catch {
    const err = new Error("Invalid token");
    err.status = 401;
    throw err;
  }

  const id = toPosInt(payload?.id ?? payload?.sub ?? payload?.user_id);
  if (!id) {
    const err = new Error("Invalid token payload");
    err.status = 401;
    throw err;
  }

  const pool = getPool();

  // ✅ user réel du token (admin ou user normal)
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

  const role = String(u.role || "").trim().toUpperCase();

  // payload impersonation (si présent)
  const actor_admin_id = toPosInt(payload?.actor_admin_id) || null;
  const impersonate_shop_id = toPosInt(payload?.impersonate_shop_id) || null;
  const impersonate_user_id = toPosInt(payload?.impersonate_user_id) || null;

  const is_impersonating =
    role === "ADMIN" && (!!impersonate_shop_id || !!impersonate_user_id);

  // ✅ resolve "effective_user_id" + effective_role + effective_shop_id
  let effective_user_id = u.id;
  let effective_role = role;
  let effective_shop_id = null;

  if (is_impersonating) {
    // 1) si impersonate_user_id fourni -> role/user = source
    if (impersonate_user_id) {
      const [tr] = await pool.query(
        "SELECT id, role FROM users WHERE id=? LIMIT 1",
        [impersonate_user_id]
      );
      const tu = tr && tr[0];
      if (tu) {
        effective_user_id = Number(tu.id);
        effective_role = String(tu.role || "").trim().toUpperCase();
      }
    }

    // 2) si shop_id fourni -> essayer de résoudre owner + fixer effective_shop_id
    if (impersonate_shop_id) {
      const [sr] = await pool.query(
        "SELECT id, owner_id FROM shops WHERE id=? LIMIT 1",
        [impersonate_shop_id]
      );
      const shop = sr && sr[0];
      if (shop) {
        effective_shop_id = Number(shop.id);

        // si pas encore d’effective_user_id (pas fourni) -> owner_id devient effective_user_id
        if (!impersonate_user_id && shop.owner_id) {
          const ownerId = Number(shop.owner_id);
          if (ownerId > 0) {
            const [or] = await pool.query(
              "SELECT id, role FROM users WHERE id=? LIMIT 1",
              [ownerId]
            );
            const ou = or && or[0];
            if (ou) {
              effective_user_id = Number(ou.id);
              effective_role = String(ou.role || "").trim().toUpperCase();
            } else {
              effective_user_id = ownerId;
            }
          }
        }
      }
    }

    // si on n’a pas trouvé shop_id, essayer de prendre le 1er shop du user effectif
    if (!effective_shop_id && effective_user_id) {
      const [sr2] = await pool.query(
        "SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1",
        [effective_user_id]
      );
      if (sr2 && sr2[0]?.id) effective_shop_id = Number(sr2[0].id);
    }
  }

  const profileFlags = await getProfileFlags(pool, effective_user_id);

  req.user = {
    // ✅ identité réelle (token owner)
    id: Number(u.id),
    uid: String(u.id),
    phone: u.phone,
    role,

    // ✅ impersonation raw infos
    actor_admin_id: is_impersonating ? (actor_admin_id || Number(u.id)) : null,
    impersonate_shop_id: is_impersonating ? impersonate_shop_id : null,
    impersonate_user_id: is_impersonating ? impersonate_user_id : null,
    is_impersonating: !!is_impersonating,

    // ✅ identité "qui agit réellement"
    effective_user_id: Number(effective_user_id),
    effective_role: String(effective_role || role),
    effective_shop_id: effective_shop_id != null ? Number(effective_shop_id) : null,

    // ✅ accès double rôle (voir getProfileFlags)
    ...profileFlags,
  };
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
  } finally {
    return next();
  }
}

function requireRole(...roles) {
  const allowed = (roles || []).map((r) => String(r || "").toUpperCase());
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      if (!req.user) await attachUserOrThrow(req);

      // ✅ IMPORTANT:
      // requireRole garde le rôle réel (ADMIN reste ADMIN même en impersonation)
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

/* =========================
 * Role helpers (✅ basés sur effective_role)
 * =======================*/
function getActingRole(u) {
  return String(u?.effective_role || u?.role || "").toUpperCase();
}

const isAdmin = (u) => String(u?.role || "").toUpperCase() === "ADMIN";

const isVendor = (u) => {
  const r = getActingRole(u);
  return r === "VENDEUR" || r === "VENDOR" || r === "SELLER";
};

const isSupplier = (u) => {
  const r = getActingRole(u);
  return r === "FOURNISSEUR" || r === "SUPPLIER";
};

const isRestaurant = (u) => getActingRole(u) === "RESTAURANT";

// ✅ Accès double rôle : vrai si rôle principal correspond OU si l'utilisateur
// a une ligne de profil dans la table dédiée (voir getProfileFlags) — un
// livreur qui devient aussi commercial garde role='LIVREUR' mais passe ces
// deux checks.
const isLivreur = (u) => getActingRole(u) === "LIVREUR" || !!u?.has_livreur_profile;

const isCommercial = (u) =>
  getActingRole(u) === "COMMERCIAL" || !!u?.has_commercial_profile;

// ✅ Garde générique basée sur une fonction de capacité (isLivreur/isCommercial/...)
// plutôt que sur un match de rôle strict — même forme que requireRole pour
// rester un remplacement direct sur les routes en libre-service.
function requireCapability(checkFn, label) {
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      if (!req.user) await attachUserOrThrow(req);
      if (!checkFn(req.user)) {
        return res
          .status(403)
          .json({ error: `Forbidden: requires ${label} capability` });
      }
      return next();
    } catch (e) {
      const status = e?.status || 401;
      return res.status(status).json({ error: e?.message || "Unauthorized" });
    }
  };
}

module.exports = {
  authRequired,
  optionalAuth,
  requireRole,
  requireCapability,
  getProfileFlags,
  isAdmin,
  isVendor,
  isSupplier,
  isRestaurant,
  isLivreur,
  isCommercial,
};