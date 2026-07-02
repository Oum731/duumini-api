// src/routes/countries.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { getCountryConfigCached } = require("../utils/country");

const router = Router();

/* ========= GET /api/countries =========
 * Public. Retourne tous les pays configurés (actifs et à venir), triés par
 * sort_order — utilisé à la fois par /pays (affiche les deux statuts) et
 * par les sélecteurs de boutique (qui ne proposent que is_active=1). */
router.get("/", async (req, res) => {
  try {
    const pool = getPool();
    const rows = await getCountryConfigCached(pool);
    res.json({ items: rows });
  } catch (e) {
    console.error("GET /api/countries error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
