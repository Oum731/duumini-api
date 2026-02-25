// users.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
const bcrypt = require("bcryptjs");

const router = Router();

function normalizeVille(ville) {
  if (ville == null) return null;
  const v = String(ville).trim();
  return v ? v : null;
}

function adminRequired(req, res, next) {
  if (!req.user || String(req.user.role || "").toUpperCase() !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function normalizeRole(role) {
  const r = String(role || "").trim().toUpperCase();
  const ROLES = ["MEMBER", "CLIENT", "VENDEUR", "FOURNISSEUR", "RESTAURANT", "LIVREUR", "ADMIN"];
  return ROLES.includes(r) ? r : "MEMBER";
}

async function getMyShops(pool, userId) {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, slug, city, owner_id, shop_type
       FROM shops
       WHERE owner_id=?
       ORDER BY id ASC`,
      [userId]
    );
    return rows || [];
  } catch {
    // Si shop_type n'existe pas encore, on retombe sur une sélection basique
    const [rows] = await pool.query(
      `SELECT id, name, slug, city, owner_id
       FROM shops
       WHERE owner_id=?
       ORDER BY id ASC`,
      [userId]
    );
    return (rows || []).map((s) => ({ ...s, shop_type: null }));
  }
}

/**
 * GET /api/user/me
 * - retourne aussi shops + impersonation si présente dans le token
 */
router.get("/me", authRequired, async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE id=?`,
      [req.user.id]
    );

    const me = rows[0] || null;
    if (!me) return res.json(null);

    const shops = await getMyShops(pool, req.user.id);

    const actor_admin_id = req.user.actor_admin_id != null ? Number(req.user.actor_admin_id) : null;
    const impersonate_shop_id = req.user.impersonate_shop_id != null ? Number(req.user.impersonate_shop_id) : null;

    res.json({
      ...me,
      shops,
      impersonation: impersonate_shop_id
        ? { actor_admin_id, impersonate_shop_id }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/user/me
 */
router.put("/me", authRequired, async (req, res) => {
  const { first_name, last_name, avatar, ville, commune, quartier, sexe, phone } = req.body || {};
  const pool = getPool();

  const fields = [];
  const values = [];

  if (typeof first_name !== "undefined") {
    fields.push("first_name=?");
    values.push(first_name || null);
  }
  if (typeof last_name !== "undefined") {
    fields.push("last_name=?");
    values.push(last_name || null);
  }
  if (typeof avatar !== "undefined") {
    fields.push("avatar=?");
    values.push(avatar || null);
  }
  if (typeof ville !== "undefined") {
    fields.push("ville=?");
    values.push(normalizeVille(ville));
  }
  if (typeof commune !== "undefined") {
    fields.push("commune=?");
    values.push(commune || null);
  }
  if (typeof quartier !== "undefined") {
    fields.push("quartier=?");
    values.push(quartier || null);
  }
  if (typeof sexe !== "undefined") {
    const _sexe = ["M", "F"].includes(sexe) ? sexe : null;
    fields.push("sexe=?");
    values.push(_sexe);
  }
  if (typeof phone !== "undefined") {
    fields.push("phone=?");
    values.push(String(phone).trim());
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  try {
    if (typeof phone !== "undefined") {
      const [dups] = await pool.query(
        "SELECT id FROM users WHERE phone=? AND id<>? LIMIT 1",
        [String(phone).trim(), req.user.id]
      );
      if (dups && dups.length) {
        return res.status(409).json({ error: "Phone already exists" });
      }
    }

    const sql = `UPDATE users SET ${fields.join(", ")} WHERE id=?`;
    await pool.query(sql, [...values, req.user.id]);

    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE id=?`,
      [req.user.id]
    );

    const me = rows[0] || null;
    const shops = await getMyShops(pool, req.user.id);

    res.json({ ...me, shops });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================
 *            🔒 ADMIN
 * ============================ */

router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || "20", 10)));
  const q = (req.query.q || "").toString().trim();
  const role = (req.query.role || "").toString().trim();

  const pool = getPool();
  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push(`(phone LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR role LIKE ?)`);
    params.push(like, like, like, like);
  }
  if (role) {
    where.push(`UPPER(role)=UPPER(?)`);
    params.push(role);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

  try {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM users ${whereSql}`,
      params
    );

    const [rows] = await pool.query(
      `
      SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
      FROM users
      ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );

    res.json({ items: rows, pageInfo: { page, pageSize, total } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/user
 */
router.post("/", authRequired, adminRequired, async (req, res) => {
  const { phone, password, first_name, last_name, role } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "phone & password required" });

  const _role = normalizeRole(role);

  const pool = getPool();
  try {
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query(
      `INSERT INTO users (phone, password, role, first_name, last_name) VALUES (?,?,?,?,?)`,
      [String(phone).trim(), hash, _role, first_name || null, last_name || null]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("Duplicate")) return res.status(409).json({ error: "Phone already exists" });
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/user/:id
 */
router.put("/:id", authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { phone, first_name, last_name, ville, commune, quartier, sexe, role } = req.body || {};

  const fields = [];
  const values = [];

  if (typeof phone !== "undefined") {
    fields.push("phone=?");
    values.push(String(phone).trim());
  }
  if (typeof first_name !== "undefined") {
    fields.push("first_name=?");
    values.push(first_name || null);
  }
  if (typeof last_name !== "undefined") {
    fields.push("last_name=?");
    values.push(last_name || null);
  }
  if (typeof ville !== "undefined") {
    fields.push("ville=?");
    values.push(normalizeVille(ville));
  }
  if (typeof commune !== "undefined") {
    fields.push("commune=?");
    values.push(commune || null);
  }
  if (typeof quartier !== "undefined") {
    fields.push("quartier=?");
    values.push(quartier || null);
  }
  if (typeof sexe !== "undefined") {
    const _sexe = ["M", "F"].includes(sexe) ? sexe : null;
    fields.push("sexe=?");
    values.push(_sexe);
  }
  if (typeof role !== "undefined") {
    const _role = normalizeRole(role);
    fields.push("role=?");
    values.push(_role);
  }

  if (!fields.length) return res.status(400).json({ error: "No fields" });

  try {
    const pool = getPool();

    if (typeof phone !== "undefined") {
      const [dups] = await pool.query(
        "SELECT id FROM users WHERE phone=? AND id<>? LIMIT 1",
        [String(phone).trim(), id]
      );
      if (dups && dups.length) return res.status(409).json({ error: "Phone already exists" });
    }

    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id=?`, [...values, id]);

    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
       FROM users WHERE id=?`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id/role", authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  const _role = normalizeRole(role);
  const pool = getPool();

  try {
    await pool.query(`UPDATE users SET role=? WHERE id=?`, [_role, id]);
    const [rows] = await pool.query(
      `SELECT id, phone, role, first_name, last_name, avatar, ville, commune, quartier, sexe, created_at
       FROM users WHERE id=?`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", authRequired, adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pool = getPool();
  try {
    await pool.query(`DELETE FROM users WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;