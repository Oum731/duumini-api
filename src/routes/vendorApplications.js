// src/routes/vendorApplications.js
const { Router } = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const bcrypt = require("bcryptjs");

const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { normalizeCountryCode } = require("../utils/country");
const { normPhone } = require("../utils/phone");
const { env } = require("../lib/env");

const router = Router();

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
});

const APPLICANT_TYPES = ["VENDEUR", "FOURNISSEUR", "RESTAURANT"];

function uploadBufferToCloudinary(file, folder = "vendor-applications") {
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

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

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

/* ========= POST /api/vendor-applications ========= */
/* Publique : le candidat n'a pas encore de compte. */
router.post(
  "/",
  upload.fields([
    { name: "dfe_file", maxCount: 1 },
    { name: "rc_file", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        applicant_type,
        legal_name,
        contact_phone,
        contact_email,
        country_code,
        city,
        message,
      } = req.body || {};

      const type = String(applicant_type || "").toUpperCase();
      if (!APPLICANT_TYPES.includes(type)) {
        return res.status(400).json({
          error: `applicant_type invalide (attendu: ${APPLICANT_TYPES.join(", ")})`,
        });
      }

      const cleanLegalName = String(legal_name || "").trim();
      const cleanPhone = normPhone(contact_phone);
      if (!cleanLegalName || !cleanPhone) {
        return res.status(400).json({ error: "legal_name et contact_phone requis" });
      }

      const pool = getPool();
      const finalCountryCode = await normalizeCountryCode(pool, country_code, "MA");

      const dfeFile = (req.files && req.files.dfe_file && req.files.dfe_file[0]) || null;
      const rcFile = (req.files && req.files.rc_file && req.files.rc_file[0]) || null;

      const [dfeUrl, rcUrl] = await Promise.all([
        uploadBufferToCloudinary(dfeFile, "vendor-applications/dfe"),
        uploadBufferToCloudinary(rcFile, "vendor-applications/rc"),
      ]);

      const [r] = await pool.query(
        `INSERT INTO vendor_applications
           (applicant_type, legal_name, contact_phone, contact_email, country_code, city, message, dfe_url, rc_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          type,
          cleanLegalName,
          cleanPhone,
          contact_email || null,
          finalCountryCode,
          city || null,
          message || null,
          dfeUrl,
          rcUrl,
        ]
      );

      res.status(201).json({ id: r.insertId, status: "PENDING" });
    } catch (e) {
      console.error("POST /api/vendor-applications error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* ========= GET /api/vendor-applications ========= */
router.get("/", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset, limit } = getPagination(req);
    const status = String(req.query.status || "").toUpperCase();
    const q = String(req.query.q || "").trim();

    const conditions = [];
    const params = [];

    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (q) {
      conditions.push("(legal_name LIKE ? OR contact_phone LIKE ? OR contact_email LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM vendor_applications ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT * FROM vendor_applications ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    console.error("GET /api/vendor-applications error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= GET /api/vendor-applications/:id ========= */
router.get("/:id", authRequired, requireRole("ADMIN"), async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const pool = getPool();
    const [[application]] = await pool.query(
      `SELECT * FROM vendor_applications WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!application) return res.status(404).json({ error: "Application not found" });

    res.json(application);
  } catch (e) {
    console.error("GET /api/vendor-applications/:id error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ========= PATCH /api/vendor-applications/:id/approve ========= */
/* Crée le compte + la boutique, marque la candidature APPROVED. */
router.patch(
  "/:id/approve",
  authRequired,
  requireRole("ADMIN"),
  async (req, res) => {
    const id = Number(req.params.id) || 0;
    const { password } = req.body || {};

    if (!id) return res.status(400).json({ error: "Invalid id" });
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "Mot de passe requis (6 caractères minimum)" });
    }

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      const [[application]] = await conn.query(
        `SELECT * FROM vendor_applications WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!application) {
        conn.release();
        return res.status(404).json({ error: "Application not found" });
      }
      if (application.status !== "PENDING") {
        conn.release();
        return res.status(409).json({ error: "Cette candidature a déjà été traitée" });
      }

      const [existingUser] = await conn.query(
        "SELECT id FROM users WHERE phone = ? LIMIT 1",
        [application.contact_phone]
      );
      if (existingUser.length) {
        conn.release();
        return res.status(409).json({
          error: "Un compte existe déjà avec ce numéro de téléphone",
        });
      }

      await conn.beginTransaction();

      const hash = await bcrypt.hash(String(password), 10);
      const [userResult] = await conn.query(
        `INSERT INTO users (phone, password, role, first_name, last_name)
         VALUES (?, ?, ?, ?, NULL)`,
        [application.contact_phone, hash, application.applicant_type, application.legal_name]
      );
      const newUserId = userResult.insertId;

      const slug = await generateUniqueSlug(pool, slugify(application.legal_name));
      await conn.query(
        `INSERT INTO shops
           (owner_id, name, slug, description, address, city, country, country_code)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          newUserId,
          application.legal_name,
          slug,
          application.message || null,
          application.city || null,
          application.country_code === "CI" ? "Côte d'Ivoire" : "Maroc",
          application.country_code,
        ]
      );

      await conn.query(
        `UPDATE vendor_applications
            SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW()
          WHERE id = ?`,
        [req.user.id, id]
      );

      await conn.commit();

      res.json({ ok: true, user_id: newUserId });
    } catch (e) {
      await conn.rollback();
      console.error("PATCH /api/vendor-applications/:id/approve error:", e);
      res.status(500).json({ error: e?.message || "Erreur serveur" });
    } finally {
      conn.release();
    }
  }
);

/* ========= PATCH /api/vendor-applications/:id/reject ========= */
router.patch(
  "/:id/reject",
  authRequired,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const id = Number(req.params.id) || 0;
      const { admin_notes } = req.body || {};
      if (!id) return res.status(400).json({ error: "Invalid id" });

      const pool = getPool();
      const [result] = await pool.query(
        `UPDATE vendor_applications
            SET status = 'REJECTED', admin_notes = ?, reviewed_by = ?, reviewed_at = NOW()
          WHERE id = ? AND status = 'PENDING'`,
        [admin_notes || null, req.user.id, id]
      );

      if (!result.affectedRows) {
        return res.status(409).json({
          error: "Candidature introuvable ou déjà traitée",
        });
      }

      res.json({ ok: true });
    } catch (e) {
      console.error("PATCH /api/vendor-applications/:id/reject error:", e);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

module.exports = router;
