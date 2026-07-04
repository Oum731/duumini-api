// api/routes/shops.js
const { Router } = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const { getPool } = require("../lib/db");
const {
  authRequired,
  requireRole,
  isAdmin,
  isVendor,
} = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { normalizeCountryCode } = require("../utils/country");
const { env } = require("../lib/env");

const router = Router();

/* ========= Cloudinary config (comme pour les produits) ========= */
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

/* ========= Multer en mémoire (pour envoyer le buffer à Cloudinary) ========= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
});

/* ========= Helpers ========= */

// Slugify simple
function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// Générer un slug unique dans la table shops
async function generateUniqueSlug(pool, base) {
  let slug = base || "shop";
  let suffix = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [rows] = await pool.query(
      "SELECT id FROM shops WHERE slug = ? LIMIT 1",
      [slug]
    );
    if (!rows.length) return slug;
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
}

// Upload buffer vers Cloudinary, retourne l'URL
function uploadBufferToCloudinary(file, folder = "shops") {
  if (!file || !file.buffer) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const now = new Date();
    const folderPath = `${folder}/${now.getFullYear()}/${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: folderPath },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );

    uploadStream.end(file.buffer);
  });
}

/* ============================================================================
 * GET /api/shops
 * Liste paginée des boutiques (publique), avec recherche q optionnelle.
 * Query: page, pageSize, q
 * ==========================================================================*/
router.get("/", async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  const q = (req.query.q || "").toString().trim();

  try {
    let where = "WHERE 1";
    const paramsCount = [];
    if (q) {
      where += " AND (s.name LIKE ? OR s.city LIKE ?)";
      paramsCount.push(`%${q}%`, `%${q}%`);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM shops s ${where}`,
      paramsCount
    );

    const paramsData = [...paramsCount, limit, offset];

    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
      paramsData
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    console.error("GET /api/shops error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ============================================================================
 * GET /api/shops/mine
 * Boutiques du vendeur / admin connecté.
 * ==========================================================================*/
router.get(
  "/mine",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  async (req, res) => {
    const pool = getPool();
    try {
      const [rows] = await pool.query(
        `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
         FROM shops s
         LEFT JOIN shop_categories sc ON sc.id = s.category_id
         WHERE s.owner_id=?
         ORDER BY s.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (e) {
      console.error("GET /api/shops/mine error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ============================================================================
 * GET /api/shops/by-slug/:slug
 * Détail public d'une boutique par slug — pour la vitrine publique
 * /boutique/:slug. Doit être déclarée avant GET /:id pour éviter que
 * express matche "by-slug" comme un :id.
 * ==========================================================================*/
router.get("/by-slug/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Invalid slug" });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.slug=?`,
      [slug]
    );
    const shop = rows[0];
    if (!shop || shop.is_active === 0) {
      return res.status(404).json({ error: "Shop not found" });
    }
    res.json(shop);
  } catch (e) {
    console.error("GET /api/shops/by-slug/:slug error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ============================================================================
 * GET /api/shops/:id
 * Détail public d’une boutique.
 * ==========================================================================*/
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
       FROM shops s
       LEFT JOIN shop_categories sc ON sc.id = s.category_id
       WHERE s.id=?`,
      [id]
    );
    const shop = rows[0];
    if (!shop) return res.status(404).json({ error: "Shop not found" });
    res.json(shop);
  } catch (e) {
    console.error("GET /api/shops/:id error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ============================================================================
 * GET /api/shops/:id/stats
 * ==========================================================================*/
router.get(
  "/:id/stats",
  authRequired,
  requireRole("ADMIN", "VENDEUR"),
  async (req, res) => {
    const shopId = Number(req.params.id) || 0;
    if (!shopId) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();

    try {
      // Vérifier que la boutique existe + owner_id
      const [rowsShop] = await pool.query(
        "SELECT id, name, owner_id FROM shops WHERE id=? LIMIT 1",
        [shopId]
      );
      if (!rowsShop.length) {
        return res.status(404).json({ error: "Shop not found" });
      }

      const shop = rowsShop[0];

      // 🔐 Si VENDEUR → il doit être propriétaire de la boutique
      if (!isAdmin(req.user) && isVendor(req.user)) {
        if (String(shop.owner_id) !== String(req.user.id)) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      // On ne compte que les commandes "valides"
      const validStatuses = ["OPEN", "PREPARATION", "DELIVERY", "DONE"];

      const [rowsTurnover] = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE
            WHEN DATE(o.created_at) = CURDATE()
            THEN oi.qty * COALESCE(oi.unit_price, 0)
          END), 0) AS day_turnover,

          COALESCE(SUM(CASE
            WHEN YEAR(o.created_at) = YEAR(CURDATE())
              AND MONTH(o.created_at) = MONTH(CURDATE())
            THEN oi.qty * COALESCE(oi.unit_price, 0)
          END), 0) AS month_turnover,

          COALESCE(SUM(CASE
            WHEN YEAR(o.created_at) = YEAR(CURDATE())
            THEN oi.qty * COALESCE(oi.unit_price, 0)
          END), 0) AS year_turnover
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        WHERE p.shop_id = ?
          AND o.status IN (${validStatuses.map(() => "?").join(",")})
        `,
        [shopId, ...validStatuses]
      );

      const t = rowsTurnover[0] || {
        day_turnover: 0,
        month_turnover: 0,
        year_turnover: 0,
      };

      const turnover = {
        day: Number(t.day_turnover || 0),
        month: Number(t.month_turnover || 0),
        year: Number(t.year_turnover || 0),
      };

      const [rowsCommission] = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE
            WHEN DATE(o.created_at) = CURDATE()
            THEN oi.qty * COALESCE(oi.unit_price, 0)
              * CASE
                  WHEN LOWER(TRIM(COALESCE(p.sub_category, ''))) = 'food' THEN 0.18
                  ELSE 0.11
                END
          END), 0) AS day_commission,

          COALESCE(SUM(CASE
            WHEN YEAR(o.created_at) = YEAR(CURDATE())
              AND MONTH(o.created_at) = MONTH(CURDATE())
            THEN oi.qty * COALESCE(oi.unit_price, 0)
              * CASE
                  WHEN LOWER(TRIM(COALESCE(p.sub_category, ''))) = 'food' THEN 0.18
                  ELSE 0.11
                END
          END), 0) AS month_commission,

          COALESCE(SUM(CASE
            WHEN YEAR(o.created_at) = YEAR(CURDATE())
            THEN oi.qty * COALESCE(oi.unit_price, 0)
              * CASE
                  WHEN LOWER(TRIM(COALESCE(p.sub_category, ''))) = 'food' THEN 0.18
                  ELSE 0.11
                END
          END), 0) AS year_commission
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        WHERE p.shop_id = ?
          AND o.status IN (${validStatuses.map(() => "?").join(",")})
        `,
        [shopId, ...validStatuses]
      );

      const c = rowsCommission[0] || {
        day_commission: 0,
        month_commission: 0,
        year_commission: 0,
      };

      const duumini = {
        day: Number(c.day_commission || 0),
        month: Number(c.month_commission || 0),
        year: Number(c.year_commission || 0),
      };

      const [rowsTopProducts] = await pool.query(
        `
        SELECT
          oi.product_id,
          COALESCE(p.name, CONCAT('Produit #', oi.product_id)) AS name,
          (
            SELECT pi.url
            FROM product_images pi
            WHERE pi.product_id = p.id
            ORDER BY pi.sort_order ASC, pi.id ASC
            LIMIT 1
          ) AS cover,
          SUM(oi.qty) AS total_qty,
          SUM(oi.qty * COALESCE(oi.unit_price, 0)) AS total_amount
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        WHERE
          p.shop_id = ?
          AND o.status IN (${validStatuses.map(() => "?").join(",")})
          AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY oi.product_id, name
        ORDER BY total_qty DESC, total_amount DESC
        LIMIT 10
        `,
        [shopId, ...validStatuses]
      );

      const top_products = rowsTopProducts.map((r) => ({
        product_id: r.product_id,
        name: r.name,
        total_qty: Number(r.total_qty || 0),
        total_amount: Number(r.total_amount || 0),
        cover: r.cover || null,
      }));

      res.json({ turnover, duumini, top_products });
    } catch (e) {
      console.error("GET /api/shops/:id/stats error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ============================================================================
 * POST /api/shops
 * Création d’une boutique (VENDEUR ou ADMIN).
 * ==========================================================================*/
router.post(
  "/",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.fields([
    { name: "logo_file", maxCount: 1 },
    { name: "cover_file", maxCount: 1 },
  ]),
  async (req, res) => {
    const pool = getPool();
    const owner_id = req.user.id;

    try {
      // ✅ Limite simple : VENDEUR max 2 boutiques
      // (Admin illimité — si tu veux limiter admin aussi, dis-moi)
      if (isVendor(req.user) && !isAdmin(req.user)) {
        const [[{ total }]] = await pool.query(
          "SELECT COUNT(*) AS total FROM shops WHERE owner_id=?",
          [owner_id]
        );
        const count = Number(total || 0);
        if (count >= 2) {
          return res.status(409).json({
            error: "SHOP_LIMIT_REACHED",
            message: "Vous avez déjà atteint la limite de 2 boutiques.",
            limit: 2,
          });
        }
      }

      const {
        name,
        description,
        category_id,
        address,
        city,
        country,
        country_code,
        lat,
        lng,
        logo: logoText,
        cover: coverText,
      } = req.body || {};

      const rawName = (name ?? "").toString().trim();
      if (!rawName) {
        return res.status(400).json({ error: "name required" });
      }
      const finalName = rawName;

      const finalCountryCode = await normalizeCountryCode(
        pool,
        country_code || country,
        "MA"
      );

      const baseSlug = slugify(finalName);
      const slug = await generateUniqueSlug(pool, baseSlug);

      const logoFile =
        (req.files && req.files.logo_file && req.files.logo_file[0]) || null;
      const coverFile =
        (req.files && req.files.cover_file && req.files.cover_file[0]) || null;

      let logoUrl = logoText || null;
      let coverUrl = coverText || null;

      if (logoFile) {
        logoUrl = await uploadBufferToCloudinary(logoFile, "shops/logo");
      }
      if (coverFile) {
        coverUrl = await uploadBufferToCloudinary(coverFile, "shops/cover");
      }

      const finalDescription =
        typeof description === "string" && description.trim()
          ? description.trim()
          : null;

      const [r] = await pool.query(
        `INSERT INTO shops (
           owner_id, name, slug, description, category_id, address, city, country,
           country_code, lat, lng, logo, cover
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          owner_id,
          finalName,
          slug,
          finalDescription,
          category_id || null,
          address || null,
          city || null,
          country || "Maroc",
          finalCountryCode,
          lat || null,
          lng || null,
          logoUrl,
          coverUrl,
        ]
      );

      const newId = r.insertId;
      const [rows] = await pool.query(
        `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
         FROM shops s
         LEFT JOIN shop_categories sc ON sc.id = s.category_id
         WHERE s.id=?`,
        [newId]
      );

      res.status(201).json(rows[0]);
    } catch (e) {
      console.error("POST /api/shops error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ============================================================================
 * PUT /api/shops/:id
 * Mise à jour d’une boutique (admin ou vendeur propriétaire).
 * ==========================================================================*/
router.put(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.fields([
    { name: "logo_file", maxCount: 1 },
    { name: "cover_file", maxCount: 1 },
  ]),
  async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();

    try {
      const [rowsOwner] = await pool.query(`SELECT * FROM shops WHERE id=?`, [
        id,
      ]);
      const existing = rowsOwner[0];
      if (!existing) return res.status(404).json({ error: "Shop not found" });

      if (
        !isAdmin(req.user) &&
        !(isVendor(req.user) && existing.owner_id === req.user.id)
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const {
        name,
        description,
        category_id,
        address,
        city,
        country,
        country_code,
        lat,
        lng,
        logo: logoText,
        cover: coverText,
      } = req.body || {};

      const newName =
        (name ?? existing.name).toString().trim() || existing.name;
      let newSlug = existing.slug;

      if (name && newName !== existing.name) {
        const baseSlug = slugify(newName);
        newSlug = await generateUniqueSlug(pool, baseSlug);
      }

      const finalDescription =
        description != null
          ? (description || "").toString().trim() || null
          : existing.description;

      const logoFile =
        (req.files && req.files.logo_file && req.files.logo_file[0]) || null;
      const coverFile =
        (req.files && req.files.cover_file && req.files.cover_file[0]) || null;

      let logoUrl = existing.logo;
      let coverUrl = existing.cover;

      if (logoText != null) {
        logoUrl = logoText || null;
      }
      if (coverText != null) {
        coverUrl = coverText || null;
      }

      if (logoFile) {
        logoUrl = await uploadBufferToCloudinary(logoFile, "shops/logo");
      }
      if (coverFile) {
        coverUrl = await uploadBufferToCloudinary(coverFile, "shops/cover");
      }

      const newCountryCode =
        country_code || country
          ? await normalizeCountryCode(pool, country_code || country, existing.country_code || "MA")
          : existing.country_code || "MA";

      await pool.query(
        `UPDATE shops
         SET name=?, slug=?, description=?, category_id=?, address=?, city=?, country=?,
             country_code=?, lat=?, lng=?, logo=?, cover=?
         WHERE id=?`,
        [
          newName,
          newSlug,
          finalDescription,
          category_id != null ? category_id : existing.category_id,
          address != null ? address : existing.address,
          city != null ? city : existing.city,
          country || existing.country || "Maroc",
          newCountryCode,
          lat != null ? lat : existing.lat,
          lng != null ? lng : existing.lng,
          logoUrl,
          coverUrl,
          id,
        ]
      );

      const [rows] = await pool.query(
        `SELECT s.*, sc.name AS category_name, sc.slug AS category_slug
         FROM shops s
         LEFT JOIN shop_categories sc ON sc.id = s.category_id
         WHERE s.id=?`,
        [id]
      );

      res.json(rows[0]);
    } catch (e) {
      console.error("PUT /api/shops/:id error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ============================================================================
 * DELETE /api/shops/:id
 * Suppression d’une boutique (admin ou vendeur propriétaire).
 * ==========================================================================*/
router.delete(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();

    try {
      const [rowsOwner] = await pool.query(
        `SELECT owner_id FROM shops WHERE id=?`,
        [id]
      );
      const shop = rowsOwner[0];
      if (!shop) return res.status(404).json({ error: "Shop not found" });

      if (
        !isAdmin(req.user) &&
        !(isVendor(req.user) && shop.owner_id === req.user.id)
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await pool.query(`DELETE FROM shops WHERE id=?`, [id]);
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/shops/:id error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

module.exports = router;