// api/routes/shops.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');

// 🔹 Upload images (Cloudinary + multer mémoire)
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { env } = require('../lib/env');

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

function uploadBufferToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const folder = `shops/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: filename ? filename.replace(/\.[^.]+$/, '') : undefined,
        resource_type: 'image',
        overwrite: false,
        invalidate: false,
      },
      (err, res) => {
        if (err) return reject(err);
        resolve(res);
      }
    );

    uploadStream.end(buffer);
  });
}

// 🔹 Helpers slug
function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'shop';
}

async function generateUniqueSlug(pool, baseName) {
  const base = slugify(baseName);
  let candidate = base;
  let i = 0;

  // On boucle jusqu'à trouver un slug libre
  // (en général ça s'arrête très vite)
  // shops.slug doit avoir un index UNIQUE
  // pour que ce soit vraiment safe.
  // Mais même sans, ce check évite les collisions basiques.
  // Note: si beaucoup de shops avec le même nom → suffixes -1, -2, ...
  // Ça reste lisible.
  for (;;) {
    const [[row]] = await pool.query(
      'SELECT id FROM shops WHERE slug = ? LIMIT 1',
      [candidate]
    );
    if (!row) return candidate;
    i += 1;
    candidate = `${base}-${i}`;
  }
}

const router = Router();

/**
 * GET /api/shops
 * Liste paginée des boutiques (publique), avec recherche q optionnelle.
 * Query: page, pageSize, q
 */
router.get('/', async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();
  const q = (req.query.q || '').toString().trim();

  try {
    // WHERE dynamique pour la recherche
    let where = 'WHERE 1';
    const paramsCount = [];
    if (q) {
      where += ' AND (s.name LIKE ? OR s.city LIKE ?)';
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
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/shops/mine
 * Boutiques du vendeur / admin connecté.
 */
router.get('/mine', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
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
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/shops/:id
 * Détail public d’une boutique.
 */
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

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
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/shops
 * Création d’une boutique (VENDEUR ou ADMIN).
 *
 * 🔹 Body: multipart/form-data
 *  - champs texte: name, category_id?, address?, city?, country?, lat?, lng?
 *  - fichiers: logo_file?, cover_file?
 *
 * Le slug est généré automatiquement à partir du nom.
 */
router.post(
  '/',
  authRequired,
  requireRole('VENDEUR', 'ADMIN'),
  upload.fields([
    { name: 'logo_file', maxCount: 1 },
    { name: 'cover_file', maxCount: 1 },
  ]),
  async (req, res) => {
    const {
      name,
      category_id,
      address,
      city,
      country,
      lat,
      lng,
      // logo, cover éventuels en texte (URL directe) si tu veux
      logo: logoUrlFromBody,
      cover: coverUrlFromBody,
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }

    const owner_id = req.user.id;
    const pool = getPool();

    const files = req.files || {};
    const logoFile = Array.isArray(files.logo_file) && files.logo_file[0] ? files.logo_file[0] : null;
    const coverFile = Array.isArray(files.cover_file) && files.cover_file[0] ? files.cover_file[0] : null;

    try {
      // Slug auto à partir du nom
      const slug = await generateUniqueSlug(pool, name);

      // Upload logo / cover si fichiers présents
      let finalLogo = logoUrlFromBody || null;
      let finalCover = coverUrlFromBody || null;

      if (logoFile && logoFile.buffer && logoFile.mimetype?.startsWith('image/')) {
        const up = await uploadBufferToCloudinary(logoFile.buffer, logoFile.originalname || undefined);
        finalLogo = up?.secure_url || up?.url || finalLogo;
      }

      if (coverFile && coverFile.buffer && coverFile.mimetype?.startsWith('image/')) {
        const up = await uploadBufferToCloudinary(coverFile.buffer, coverFile.originalname || undefined);
        finalCover = up?.secure_url || up?.url || finalCover;
      }

      const [r] = await pool.query(
        `INSERT INTO shops (owner_id, name, slug, category_id, address, city, country, lat, lng, logo, cover, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, NOW(), NOW())`,
        [
          owner_id,
          name,
          slug,
          category_id || null,
          address || null,
          city || null,
          country || 'Maroc',
          lat || null,
          lng || null,
          finalLogo,
          finalCover,
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
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * PUT /api/shops/:id
 * Mise à jour d’une boutique (admin ou vendeur propriétaire).
 *
 * 🔹 Body: multipart/form-data ou JSON
 *  - texte: name?, category_id?, address?, city?, country?, lat?, lng?, slug?
 *  - fichiers: logo_file?, cover_file?
 *
 * Si slug non fourni → on garde l’ancien.
 */
router.put(
  '/:id',
  authRequired,
  requireRole('VENDEUR', 'ADMIN'),
  upload.fields([
    { name: 'logo_file', maxCount: 1 },
    { name: 'cover_file', maxCount: 1 },
  ]),
  async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const {
      name,
      slug: slugFromBody,
      category_id,
      address,
      city,
      country,
      lat,
      lng,
      logo: logoUrlFromBody,
      cover: coverUrlFromBody,
    } = req.body || {};

    const pool = getPool();

    const files = req.files || {};
    const logoFile = Array.isArray(files.logo_file) && files.logo_file[0] ? files.logo_file[0] : null;
    const coverFile = Array.isArray(files.cover_file) && files.cover_file[0] ? files.cover_file[0] : null;

    try {
      // Vérifier l’existence et le propriétaire
      const [rowsOwner] = await pool.query(
        `SELECT owner_id, slug, logo, cover FROM shops WHERE id=?`,
        [id]
      );
      const shop = rowsOwner[0];
      if (!shop) return res.status(404).json({ error: 'Shop not found' });

      if (!isAdmin(req.user) && !(isVendor(req.user) && shop.owner_id === req.user.id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Slug : si fourni explicitement, on l’utilise (après trim),
      // sinon on garde l’ancien.
      const slugToUse =
        slugFromBody && String(slugFromBody).trim()
          ? String(slugFromBody).trim()
          : shop.slug;

      // Upload logo / cover si fichiers présents
      let finalLogo = logoUrlFromBody != null ? logoUrlFromBody : shop.logo;
      let finalCover = coverUrlFromBody != null ? coverUrlFromBody : shop.cover;

      if (logoFile && logoFile.buffer && logoFile.mimetype?.startsWith('image/')) {
        const up = await uploadBufferToCloudinary(logoFile.buffer, logoFile.originalname || undefined);
        finalLogo = up?.secure_url || up?.url || finalLogo;
      }

      if (coverFile && coverFile.buffer && coverFile.mimetype?.startsWith('image/')) {
        const up = await uploadBufferToCloudinary(coverFile.buffer, coverFile.originalname || undefined);
        finalCover = up?.secure_url || up?.url || finalCover;
      }

      await pool.query(
        `UPDATE shops
         SET name        = COALESCE(?, name),
             slug        = COALESCE(?, slug),
             category_id = COALESCE(?, category_id),
             address     = COALESCE(?, address),
             city        = COALESCE(?, city),
             country     = COALESCE(?, country),
             lat         = COALESCE(?, lat),
             lng         = COALESCE(?, lng),
             logo        = COALESCE(?, logo),
             cover       = COALESCE(?, cover),
             updated_at  = NOW()
         WHERE id=?`,
        [
          name ?? null,
          slugToUse ?? null,
          category_id != null ? category_id : null,
          address ?? null,
          city ?? null,
          country ?? null,
          lat ?? null,
          lng ?? null,
          finalLogo ?? null,
          finalCover ?? null,
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
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * DELETE /api/shops/:id
 * Suppression d’une boutique (admin ou vendeur propriétaire).
 */
router.delete('/:id', authRequired, requireRole('VENDEUR', 'ADMIN'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();

  try {
    // Vérifier l’existence et le propriétaire
    const [rowsOwner] = await pool.query(`SELECT owner_id FROM shops WHERE id=?`, [id]);
    const shop = rowsOwner[0];
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    if (!isAdmin(req.user) && !(isVendor(req.user) && shop.owner_id === req.user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query(`DELETE FROM shops WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
