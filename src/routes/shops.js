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
      {
        folder: folderPath,
      },
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
    res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  }
);

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
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================================
 * POST /api/shops
 * Création d’une boutique (VENDEUR ou ADMIN).
 * Body: multipart/form-data
 *  - name (obligatoire côté UI, fallback API si vide)
 *  - description?, category_id?, address?, city?, country?, lat?, lng?
 *  - logo_file? (fichier), cover_file? (fichier)
 *  - logo? / cover? (URL texte, en fallback si pas de fichier)
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
    console.log("CREATE SHOP BODY =", req.body); // 👈 AJOUTE ÇA

    const pool = getPool();
    const owner_id = req.user.id;

    try {
      const {
        name,
        description,
        category_id,
        address,
        city,
        country,
        lat,
        lng,
        logo: logoText,
        cover: coverText,
      } = req.body || {};

      // Nettoyage nom + fallback
      const rawName = (name ?? "").toString();
      const cleanName = rawName.trim();
      const finalName = cleanName || "Boutique";

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
           lat, lng, logo, cover
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          owner_id,
          finalName,
          slug,
          finalDescription,
          category_id || null,
          address || null,
          city || null,
          country || "Maroc",
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
      res.status(500).json({ error: e.message });
    }
  }
);

/* ============================================================================
 * PUT /api/shops/:id
 * Mise à jour d’une boutique (admin ou vendeur propriétaire).
 * Body: multipart/form-data (même principe que POST)
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

      await pool.query(
        `UPDATE shops
         SET name=?, slug=?, description=?, category_id=?, address=?, city=?, country=?, lat=?, lng=?, logo=?, cover=?
         WHERE id=?`,
        [
          newName,
          newSlug,
          finalDescription,
          category_id != null ? category_id : existing.category_id,
          address != null ? address : existing.address,
          city != null ? city : existing.city,
          country || existing.country || "Maroc",
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
