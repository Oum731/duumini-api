const express = require("express");
const { getPool } = require("../lib/db");
const auth = require("../middlewares/auth");

const router = express.Router();

const authRequired = auth.authRequired;
const isAdmin = auth.isAdmin || (() => false);
const isVendor = auth.isVendor || (() => false);
const isRestaurant = auth.isRestaurant || (() => false);
const isSupplier = auth.isSupplier || (() => false);

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(v, max = 255) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function canManage(req) {
  return (
    isAdmin(req.user) ||
    isVendor(req.user) ||
    isRestaurant(req.user) ||
    isSupplier(req.user)
  );
}

function currentShopId(req) {
  if (isAdmin(req.user)) {
    return toNum(req.query.shop_id || req.body?.shop_id, 0) || null;
  }
  return toNum(req.user?.shop_id, 0) || null;
}

router.get("/", authRequired, async (req, res) => {
  try {
    if (!canManage(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();
    const shopId = currentShopId(req);

    const params = [];
    let where = "WHERE is_active = 1";

    if (shopId) {
      where += " AND (shop_id IS NULL OR shop_id = ?)";
      params.push(shopId);
    }

    const [rows] = await pool.query(
      `
      SELECT
        id,
        shop_id,
        name,
        color,
        is_active,
        created_at,
        updated_at
      FROM expense_categories
      ${where}
      ORDER BY name ASC
      `,
      params
    );

    return res.json({ items: rows });
  } catch (e) {
    console.error("GET /expense-categories error:", e);
    return res.status(500).json({
      error: "Erreur serveur lors du chargement des catégories de dépenses.",
      details: e?.message || "unknown_error",
    });
  }
});

router.post("/", authRequired, async (req, res) => {
  try {
    if (!canManage(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();
    const shopId = currentShopId(req);
    const name = cleanStr(req.body?.name, 100);
    const color = cleanStr(req.body?.color, 20);

    if (!name) {
      return res.status(400).json({ error: "Le nom de la catégorie est obligatoire." });
    }

    const [[existing]] = await pool.query(
      `
      SELECT id, shop_id, name, color, is_active, created_at, updated_at
      FROM expense_categories
      WHERE name = ?
      AND ((shop_id IS NULL AND ? IS NULL) OR shop_id = ?)
      LIMIT 1
      `,
      [name, shopId, shopId]
    );

    if (existing) {
      return res.json(existing);
    }

    const [result] = await pool.query(
      `
      INSERT INTO expense_categories (shop_id, name, color, is_active)
      VALUES (?, ?, ?, 1)
      `,
      [shopId, name, color]
    );

    const [[created]] = await pool.query(
      `
      SELECT id, shop_id, name, color, is_active, created_at, updated_at
      FROM expense_categories
      WHERE id = ?
      LIMIT 1
      `,
      [result.insertId]
    );

    return res.status(201).json(created);
  } catch (e) {
    console.error("POST /expense-categories error:", e);
    return res.status(500).json({
      error: "Erreur serveur lors de la création de la catégorie.",
      details: e?.message || "unknown_error",
    });
  }
});

module.exports = router;