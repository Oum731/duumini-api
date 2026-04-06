const { Router } = require("express");
const { getPool } = require("../lib/db");
const bcrypt = require("bcryptjs");
const { signAccess, signRefresh, verifyRefresh } = require("../utils/jwt");
const { authRequired, requireRole } = require("../middlewares/auth");

const router = Router();

function normalizeVille(ville) {
  if (ville == null) return null;
  const v = String(ville).trim();
  return v ? v : null;
}

function toPosInt(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normPhone(p) {
  const raw = String(p || "").replace(/\s+/g, "");
  if (!raw) return null;
  if (raw.startsWith("+")) return raw;
  if (raw.startsWith("00")) return `+${raw.slice(2)}`;
  if (/^0\d{9,}$/.test(raw)) return `+212${raw.slice(1)}`;
  return raw;
}

/**
 * POST /api/auth/register
 */
router.post("/register", async (req, res) => {
  const {
    phone,
    password,
    first_name,
    last_name,
    avatar,
    ville,
    commune,
    quartier,
    sexe,
  } = req.body || {};

  const cleanPhone = normPhone(phone);

  if (!cleanPhone || !password) {
    return res.status(400).json({ error: "phone & password required" });
  }

  const _sexe = ["M", "F"].includes(sexe) ? sexe : null;
  const _ville = normalizeVille(ville);

  const pool = getPool();

  try {
    const [exists] = await pool.query(
      "SELECT id FROM users WHERE phone=? LIMIT 1",
      [cleanPhone]
    );

    if (exists && exists.length) {
      return res.status(409).json({
        error: "Phone already exists",
        code: "ACCOUNT_ALREADY_EXISTS",
        message:
          "Un compte existe déjà avec ce numéro. Connectez-vous puis modifiez votre mot de passe si besoin.",
      });
    }

    const hash = await bcrypt.hash(String(password), 10);

    await pool.query(
      `
      INSERT INTO users
        (phone, password, role, first_name, last_name, avatar, ville, commune, quartier, sexe)
      VALUES
        (?,?,?,?,?,?,?,?,?,?)
      `,
      [
        cleanPhone,
        hash,
        "MEMBER",
        first_name || null,
        last_name || null,
        avatar || null,
        _ville,
        commune || null,
        quartier || null,
        _sexe,
      ]
    );

    return res.status(201).json({ ok: true });
  } catch (e) {
    const msg = String((e && e.message) || "").toLowerCase();

    if (
      msg.includes("duplicate") ||
      msg.includes("duplicate entry") ||
      msg.includes("uq_users_phone")
    ) {
      return res.status(409).json({
        error: "Phone already exists",
        code: "ACCOUNT_ALREADY_EXISTS",
        message:
          "Un compte existe déjà avec ce numéro. Connectez-vous puis modifiez votre mot de passe si besoin.",
      });
    }

    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/login
 */
router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};
  const cleanPhone = normPhone(phone);

  if (!cleanPhone || !password) {
    return res.status(400).json({ error: "phone & password required" });
  }

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, phone, password, role, first_name, last_name, avatar, ville, commune, quartier, sexe
       FROM users WHERE phone=? LIMIT 1`,
      [cleanPhone]
    );

    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const access_token = signAccess({
      id: user.id,
      phone: user.phone,
      role: user.role,
    });
    const refresh_token = signRefresh({ id: user.id, role: user.role });

    return res.json({
      access_token,
      refresh_token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        ville: user.ville,
        commune: user.commune,
        quartier: user.quartier,
        sexe: user.sexe,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/impersonate (ADMIN)
 * Body:
 *  - { vendor_shop_id } OR { vendor_user_id }
 *
 * ✅ Support vendeur OU restaurant:
 * - on résout owner_id via shop_id si besoin
 * - on renvoie access_token ADMIN + impersonate_shop_id + impersonate_user_id
 */
router.post("/impersonate", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  try {
    let vendor_shop_id = toPosInt(req.body?.vendor_shop_id);
    let vendor_user_id = toPosInt(req.body?.vendor_user_id);

    if (vendor_user_id != null) {
      const [shops] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [vendor_user_id]
      );
      if (!shops.length) {
        return res.status(404).json({ error: "Vendor shop not found for this user" });
      }
      vendor_shop_id = Number(shops[0].id);
    }

    if (!vendor_shop_id) {
      return res.status(400).json({ error: "vendor_shop_id required" });
    }

    const [sr] = await pool.query(
      `SELECT id, owner_id FROM shops WHERE id=? LIMIT 1`,
      [vendor_shop_id]
    );
    const shop = sr && sr[0];
    if (!shop) return res.status(404).json({ error: "Shop not found" });

    if (!vendor_user_id && shop.owner_id) {
      vendor_user_id = toPosInt(shop.owner_id);
    }

    if (vendor_user_id) {
      const [ur] = await pool.query(
        `SELECT id, role FROM users WHERE id=? LIMIT 1`,
        [vendor_user_id]
      );
      const target = ur && ur[0];
      if (!target) return res.status(404).json({ error: "Target user not found" });
    }

    const access_token = signAccess({
      id: req.user.id,
      phone: req.user.phone,
      role: "ADMIN",
      actor_admin_id: req.user.id,
      impersonate_shop_id: vendor_shop_id,
      impersonate_user_id: vendor_user_id || null,
    });

    return res.json({
      access_token,
      impersonate_shop_id: vendor_shop_id,
      impersonate_user_id: vendor_user_id || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/refresh
 */
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) {
    return res.status(400).json({ error: "refresh_token required" });
  }

  try {
    const payload = verifyRefresh(refresh_token);
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT id, role, phone FROM users WHERE id=? LIMIT 1`,
      [payload.id]
    );

    const dbUser = rows && rows[0];
    if (!dbUser) return res.status(401).json({ error: "invalid refresh_token" });

    const access_token = signAccess({
      id: dbUser.id,
      role: dbUser.role,
      phone: dbUser.phone,
    });

    return res.json({ access_token });
  } catch {
    return res.status(401).json({ error: "invalid refresh_token" });
  }
});

/**
 * POST /api/auth/logout
 */
router.post("/logout", (_req, res) => res.json({ ok: true }));

module.exports = router;