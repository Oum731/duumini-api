// src/utils/companyAccess.js
// Niveau 2 du modèle de permission (voir docs/duumini-2.0/01-vision-produit.md §4
// dans duumini-web) : le rôle plateforme (users.role) reste géré par
// src/middlewares/auth. Ici on vérifie le rôle INTERNE à une entreprise
// précise (company_members.internal_role), scopé par company_id.

const { getPool } = require("../lib/db");
const { isAdmin } = require("../middlewares/auth");

function actingUserId(req) {
  const u = req?.user || null;
  const id = Number(u?.effective_user_id || u?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Charge le membership ACTIVE de l'utilisateur agissant pour une entreprise.
 * Retourne null si pas membre (ou membre REMOVED/INVITED).
 */
async function getActiveMembership(companyId, userId) {
  const pool = getPool();
  const [[row]] = await pool.query(
    `SELECT id, company_id, user_id, internal_role, status
       FROM company_members
      WHERE company_id = ? AND user_id = ? AND status = 'ACTIVE'
      LIMIT 1`,
    [companyId, userId]
  );
  return row || null;
}

/**
 * Middleware : exige que l'utilisateur agissant soit membre ACTIVE de
 * l'entreprise (req.params.companyId ou :id selon la route) avec un
 * internal_role dans la liste autorisée. ADMIN plateforme passe toujours.
 *
 * Pose `req.companyMembership` (ou null si ADMIN sans membership) pour
 * que le handler n'ait pas à re-requêter.
 */
function requireCompanyRole(...internalRoles) {
  const allowed = (internalRoles || []).map((r) => String(r || "").toUpperCase());

  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();

    try {
      const companyId = Number(req.params.companyId || req.params.id || 0);
      if (!companyId) {
        return res.status(400).json({ error: "companyId requis" });
      }

      if (isAdmin(req.user)) {
        req.companyMembership = null;
        return next();
      }

      const actorId = actingUserId(req);
      if (!actorId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const membership = await getActiveMembership(companyId, actorId);
      if (!membership) {
        return res
          .status(403)
          .json({ error: "Forbidden: vous n'êtes pas membre de cette entreprise" });
      }

      if (allowed.length && !allowed.includes(String(membership.internal_role))) {
        return res.status(403).json({
          error: `Forbidden: requiert le rôle ${allowed.join(" ou ")} dans cette entreprise`,
        });
      }

      req.companyMembership = membership;
      return next();
    } catch (e) {
      return res.status(500).json({ error: e?.message || "Erreur serveur" });
    }
  };
}

module.exports = { actingUserId, getActiveMembership, requireCompanyRole };
