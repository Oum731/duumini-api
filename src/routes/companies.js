// src/routes/companies.js
const { Router } = require("express");

const { getPool } = require("../lib/db");
const { authRequired, requireRole, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const {
  actingUserId,
  getActiveMembership,
  requireCompanyRole,
} = require("../utils/companyAccess");

const router = Router();

/* ========= Helpers (mêmes conventions que shops.js) ========= */

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

async function generateUniqueSlug(pool, base) {
  let slug = base || "entreprise";
  let suffix = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [rows] = await pool.query(
      "SELECT id FROM companies WHERE slug = ? LIMIT 1",
      [slug]
    );
    if (!rows.length) return slug;
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
}

const SUPPLIER_TYPES = ["FABRICANT", "IMPORTATEUR", "GROSSISTE", "DISTRIBUTEUR", "AUTRE"];

/* ========= GET /api/companies/mine ========= */
router.get("/mine", authRequired, async (req, res) => {
  try {
    const pool = getPool();
    const actorId = actingUserId(req);

    const [rows] = await pool.query(
      `SELECT c.*, cm.internal_role AS my_role
         FROM companies c
         JOIN company_members cm ON cm.company_id = c.id
        WHERE cm.user_id = ? AND cm.status = 'ACTIVE'
        ORDER BY c.created_at DESC`,
      [actorId]
    );

    res.json({ items: rows });
  } catch (e) {
    console.error("GET /api/companies/mine error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /api/companies/:id ========= */
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();
    const [[company]] = await pool.query(
      `SELECT * FROM companies WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!company) return res.status(404).json({ error: "Company not found" });

    if (!company.is_active) {
      // Entreprise désactivée : réservé aux membres / admin
      const actorId = actingUserId(req);
      const isMember = actorId ? await getActiveMembership(id, actorId) : null;
      if (!isMember && !isAdmin(req.user)) {
        return res.status(404).json({ error: "Company not found" });
      }
    }

    res.json(company);
  } catch (e) {
    console.error("GET /api/companies/:id error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= POST /api/companies ========= */
router.post(
  "/",
  authRequired,
  requireRole("VENDEUR", "FOURNISSEUR", "RESTAURANT", "ADMIN"),
  async (req, res) => {
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      const { legal_name, description, supplier_type, country_code } =
        req.body || {};

      const rawName = (legal_name ?? "").toString().trim();
      if (!rawName) {
        return res.status(400).json({ error: "legal_name required" });
      }

      const cleanSupplierType =
        supplier_type && SUPPLIER_TYPES.includes(String(supplier_type).toUpperCase())
          ? String(supplier_type).toUpperCase()
          : null;

      const cleanCountry = (country_code ?? "MA").toString().trim().toUpperCase().slice(0, 2) || "MA";

      const actorId = actingUserId(req);
      if (!actorId) return res.status(401).json({ error: "Unauthorized" });

      const slug = await generateUniqueSlug(pool, slugify(rawName));

      await conn.beginTransaction();

      const [result] = await conn.query(
        `INSERT INTO companies
           (owner_id, legal_name, slug, description, supplier_type, country_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [actorId, rawName, slug, description ?? null, cleanSupplierType, cleanCountry]
      );

      const companyId = result.insertId;

      await conn.query(
        `INSERT INTO company_members (company_id, user_id, internal_role, status)
         VALUES (?, ?, 'OWNER', 'ACTIVE')`,
        [companyId, actorId]
      );

      await conn.commit();

      const [[company]] = await pool.query(
        `SELECT * FROM companies WHERE id = ? LIMIT 1`,
        [companyId]
      );

      res.status(201).json(company);
    } catch (e) {
      await conn.rollback();
      console.error("POST /api/companies error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    } finally {
      conn.release();
    }
  }
);

/* ========= PUT /api/companies/:id ========= */
router.put(
  "/:id",
  authRequired,
  requireCompanyRole("OWNER", "MANAGER"),
  async (req, res) => {
    try {
      const id = Number(req.params.id) || 0;
      if (!id) return res.status(400).json({ error: "Invalid id" });

      const { legal_name, description, supplier_type, country_code } =
        req.body || {};

      const cleanSupplierType =
        supplier_type !== undefined
          ? supplier_type && SUPPLIER_TYPES.includes(String(supplier_type).toUpperCase())
            ? String(supplier_type).toUpperCase()
            : null
          : undefined;

      const pool = getPool();
      await pool.query(
        `UPDATE companies SET
           legal_name    = COALESCE(?, legal_name),
           description   = COALESCE(?, description),
           supplier_type = COALESCE(?, supplier_type),
           country_code  = COALESCE(?, country_code)
         WHERE id = ?`,
        [
          legal_name ?? null,
          description ?? null,
          cleanSupplierType ?? null,
          country_code ? String(country_code).toUpperCase().slice(0, 2) : null,
          id,
        ]
      );

      const [[company]] = await pool.query(
        `SELECT * FROM companies WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!company) return res.status(404).json({ error: "Company not found" });

      res.json(company);
    } catch (e) {
      console.error("PUT /api/companies/:id error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ========= DELETE /api/companies/:id ========= */
/* Soft delete (is_active=0) — jamais de suppression définitive de données
   d'entreprise (facturation/historique potentiellement liés plus tard). */
router.delete(
  "/:id",
  authRequired,
  requireCompanyRole("OWNER"),
  async (req, res) => {
    try {
      const id = Number(req.params.id) || 0;
      if (!id) return res.status(400).json({ error: "Invalid id" });

      const pool = getPool();
      await pool.query(`UPDATE companies SET is_active = 0 WHERE id = ?`, [id]);

      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/companies/:id error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ========= /:companyId/members ========= */
const membersRouter = Router({ mergeParams: true });

// GET /api/companies/:companyId/members — tout membre actif peut lister
membersRouter.get(
  "/",
  authRequired,
  requireCompanyRole(),
  async (req, res) => {
    try {
      const companyId = Number(req.params.companyId) || 0;
      const { page, pageSize, offset, limit } = getPagination(req);

      const pool = getPool();
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM company_members WHERE company_id = ? AND status = 'ACTIVE'`,
        [companyId]
      );

      const [rows] = await pool.query(
        `SELECT cm.id, cm.company_id, cm.user_id, cm.internal_role, cm.status, cm.created_at,
                u.first_name, u.last_name, u.phone
           FROM company_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.company_id = ? AND cm.status = 'ACTIVE'
          ORDER BY cm.created_at ASC
          LIMIT ? OFFSET ?`,
        [companyId, limit, offset]
      );

      res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
    } catch (e) {
      console.error("GET /api/companies/:companyId/members error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// POST /api/companies/:companyId/members — OWNER/MANAGER ajoute un membre
membersRouter.post(
  "/",
  authRequired,
  requireCompanyRole("OWNER", "MANAGER"),
  async (req, res) => {
    try {
      const companyId = Number(req.params.companyId) || 0;
      const { user_id, internal_role } = req.body || {};

      const targetUserId = Number(user_id) || 0;
      if (!targetUserId) {
        return res.status(400).json({ error: "user_id required" });
      }

      const role = String(internal_role || "").toUpperCase();
      const ALLOWED_ROLES = ["OWNER", "MANAGER", "SALES", "WAREHOUSE", "ACCOUNTANT", "VIEWER"];
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({
          error: `internal_role invalide (attendu: ${ALLOWED_ROLES.join(", ")})`,
        });
      }

      const pool = getPool();

      const [[targetUser]] = await pool.query(
        `SELECT id FROM users WHERE id = ? LIMIT 1`,
        [targetUserId]
      );
      if (!targetUser) {
        return res.status(400).json({ error: "Utilisateur introuvable" });
      }

      const existing = await getActiveMembership(companyId, targetUserId);
      if (existing) {
        return res.status(409).json({ error: "Cet utilisateur est déjà membre" });
      }

      const actorId = actingUserId(req);
      await pool.query(
        `INSERT INTO company_members (company_id, user_id, internal_role, status, invited_by)
         VALUES (?, ?, ?, 'ACTIVE', ?)
         ON DUPLICATE KEY UPDATE internal_role = VALUES(internal_role), status = 'ACTIVE', invited_by = VALUES(invited_by)`,
        [companyId, targetUserId, role, actorId]
      );

      res.status(201).json({ ok: true });
    } catch (e) {
      console.error("POST /api/companies/:companyId/members error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// PATCH /api/companies/:companyId/members/:userId — change le rôle interne
membersRouter.patch(
  "/:userId",
  authRequired,
  requireCompanyRole("OWNER", "MANAGER"),
  async (req, res) => {
    try {
      const companyId = Number(req.params.companyId) || 0;
      const targetUserId = Number(req.params.userId) || 0;
      const role = String(req.body?.internal_role || "").toUpperCase();

      const ALLOWED_ROLES = ["OWNER", "MANAGER", "SALES", "WAREHOUSE", "ACCOUNTANT", "VIEWER"];
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({
          error: `internal_role invalide (attendu: ${ALLOWED_ROLES.join(", ")})`,
        });
      }

      const pool = getPool();
      const target = await getActiveMembership(companyId, targetUserId);
      if (!target) {
        return res.status(404).json({ error: "Membre introuvable" });
      }

      if (target.internal_role === "OWNER" && role !== "OWNER") {
        const [[{ ownerCount }]] = await pool.query(
          `SELECT COUNT(*) ownerCount FROM company_members
            WHERE company_id = ? AND internal_role = 'OWNER' AND status = 'ACTIVE'`,
          [companyId]
        );
        if (Number(ownerCount) <= 1) {
          return res
            .status(400)
            .json({ error: "Impossible de rétrograder le dernier OWNER" });
        }
      }

      await pool.query(
        `UPDATE company_members SET internal_role = ? WHERE company_id = ? AND user_id = ?`,
        [role, companyId, targetUserId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("PATCH /api/companies/:companyId/members/:userId error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// DELETE /api/companies/:companyId/members/:userId — retire un membre
membersRouter.delete(
  "/:userId",
  authRequired,
  requireCompanyRole("OWNER", "MANAGER"),
  async (req, res) => {
    try {
      const companyId = Number(req.params.companyId) || 0;
      const targetUserId = Number(req.params.userId) || 0;

      const pool = getPool();
      const target = await getActiveMembership(companyId, targetUserId);
      if (!target) {
        return res.status(404).json({ error: "Membre introuvable" });
      }

      if (target.internal_role === "OWNER") {
        const [[{ ownerCount }]] = await pool.query(
          `SELECT COUNT(*) ownerCount FROM company_members
            WHERE company_id = ? AND internal_role = 'OWNER' AND status = 'ACTIVE'`,
          [companyId]
        );
        if (Number(ownerCount) <= 1) {
          return res
            .status(400)
            .json({ error: "Impossible de retirer le dernier OWNER" });
        }
      }

      await pool.query(
        `UPDATE company_members SET status = 'REMOVED' WHERE company_id = ? AND user_id = ?`,
        [companyId, targetUserId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/companies/:companyId/members/:userId error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.use("/:companyId/members", membersRouter);

module.exports = router;
