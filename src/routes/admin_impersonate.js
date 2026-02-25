// src/routes/admin_impersonate.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
const { signAccess } = require("../utils/jwt");

const router = Router();

/**
 * POST /api/admin/impersonate
 * Body: { vendor_user_id? , vendor_shop_id? }
 * -> retourne un access_token qui contient:
 *    { id: adminId, role: 'ADMIN', impersonate_shop_id, actor_admin_id }
 */
router.post("/impersonate", authRequired, requireRole("ADMIN"), async (req, res) => {
  const pool = getPool();

  try {
    let vendor_shop_id = req.body?.vendor_shop_id != null ? Number(req.body.vendor_shop_id) : null;
    const vendor_user_id = req.body?.vendor_user_id != null ? Number(req.body.vendor_user_id) : null;

    if (vendor_user_id != null) {
      // déduire shop du vendeur via owner_id
      const [rows] = await pool.query(
        `SELECT id FROM shops WHERE owner_id=? ORDER BY id ASC LIMIT 1`,
        [vendor_user_id]
      );
      if (!rows.length) return res.status(404).json({ error: "Vendor shop not found for this user" });
      vendor_shop_id = Number(rows[0].id);
    }

    if (!Number.isFinite(vendor_shop_id) || vendor_shop_id <= 0) {
      return res.status(400).json({ error: "vendor_shop_id required" });
    }

    const access_token = signAccess({
      id: req.user.id,
      role: "ADMIN",
      actor_admin_id: req.user.id,
      impersonate_shop_id: vendor_shop_id,
    });

    res.json({ access_token, impersonate_shop_id: vendor_shop_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;