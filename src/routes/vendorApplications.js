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
const { sendWhatsAppMessage } = require("../services/twilio");
const { findZoneForPoint } = require("../utils/zones");

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

const APPLICANT_TYPES = ["VENDEUR", "FOURNISSEUR", "RESTAURANT", "PARTENAIRE", "LIVREUR"];

const ID_DOCUMENT_LABELS = {
  CNI: "carte d'identité nationale",
  CARTE_SEJOUR: "carte de séjour",
  PASSPORT: "passeport",
};

/**
 * ✅ Message envoyé automatiquement au livreur dès que sa candidature est
 * approuvée — lui demande de passer à l'agence DUUMINI avec ses documents
 * originaux pour valider définitivement son inscription (le compte est créé
 * mais `verification_status` reste PENDING_VISIT jusqu'à ce passage).
 */
function buildLivreurApprovalWhatsAppMessage({ legalName, password, idDocumentType }) {
  const docLabel = ID_DOCUMENT_LABELS[idDocumentType] || "pièce d'identité";
  const lines = [
    `🛵 *Candidature DUUMINI approuvée*`,
    ``,
    `Bonjour ${legalName || ""},`.trim(),
    ``,
    `Votre candidature en tant que livreur DUUMINI a été approuvée. Votre compte a été créé.`,
    ``,
    `Pour finaliser votre inscription, merci de vous présenter à l'agence DUUMINI avec :`,
    `• Votre ${docLabel} originale`,
    `• Une pièce d'identité si différente du document déjà transmis`,
    ``,
    `📍 Agence DUUMINI : 5 rue Ennoussour RDC, Casablanca`,
    ``,
    `Vous pourrez alors accepter des courses depuis votre espace livreur.`,
  ];
  if (password) {
    lines.push(``, `Mot de passe temporaire pour vous connecter : *${password}*`);
  }
  return lines.join("\n");
}

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
    { name: "id_document_file", maxCount: 1 },
    { name: "photo_file", maxCount: 1 },
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
        lat,
        lng,
        message,
        id_document_type,
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
      const idDocFile =
        (req.files && req.files.id_document_file && req.files.id_document_file[0]) || null;
      const photoFile = (req.files && req.files.photo_file && req.files.photo_file[0]) || null;

      const [dfeUrl, rcUrl, idDocUrl, photoUrl] = await Promise.all([
        uploadBufferToCloudinary(dfeFile, "vendor-applications/dfe"),
        uploadBufferToCloudinary(rcFile, "vendor-applications/rc"),
        uploadBufferToCloudinary(idDocFile, "vendor-applications/identity"),
        uploadBufferToCloudinary(photoFile, "vendor-applications/photo"),
      ]);

      const cleanIdDocType = ["PASSPORT", "CARTE_SEJOUR", "CNI"].includes(
        String(id_document_type || "").toUpperCase()
      )
        ? String(id_document_type).toUpperCase()
        : null;

      // ✅ Position optionnelle (surtout utile pour LIVREUR) — dégradation
      // gracieuse si absente ou invalide, le candidat n'est jamais bloqué
      // par un refus de géolocalisation.
      const cleanLat = Number(lat);
      const cleanLng = Number(lng);
      const hasValidCoords =
        Number.isFinite(cleanLat) &&
        Number.isFinite(cleanLng) &&
        cleanLat >= -90 &&
        cleanLat <= 90 &&
        cleanLng >= -180 &&
        cleanLng <= 180;

      const [r] = await pool.query(
        `INSERT INTO vendor_applications
           (applicant_type, legal_name, contact_phone, contact_email, country_code, city, lat, lng, message,
            dfe_url, rc_url, id_document_url, id_document_type, photo_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          type,
          cleanLegalName,
          cleanPhone,
          contact_email || null,
          finalCountryCode,
          city || null,
          hasValidCoords ? cleanLat : null,
          hasValidCoords ? cleanLng : null,
          message || null,
          dfeUrl,
          rcUrl,
          idDocUrl,
          cleanIdDocType,
          photoUrl,
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
    const applicantTypes = String(req.query.applicant_type || "")
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => ["VENDEUR", "FOURNISSEUR", "RESTAURANT", "PARTENAIRE", "LIVREUR"].includes(t));

    const conditions = [];
    const params = [];

    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (applicantTypes.length) {
      conditions.push(`applicant_type IN (${applicantTypes.map(() => "?").join(",")})`);
      params.push(...applicantTypes);
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

      if (application.applicant_type === "LIVREUR") {
        // Un livreur n'a pas de boutique : on crée son profil livreur
        // (pays/ville de rattachement + pièce d'identité/photo transmises
        // depuis la candidature) au lieu d'une ligne `shops`. Le compte est
        // créé mais `verification_status` reste à PENDING_VISIT (valeur par
        // défaut) : il ne peut accepter des courses qu'après validation
        // manuelle par un admin suite au passage physique à l'agence.
        //
        // ✅ Si une position a été capturée à la candidature, on la copie
        // directement dans last_lat/last_lng (+ résolution de zone) — le
        // livreur a une position exploitable dès l'approbation, sans
        // attendre sa première connexion à son tableau de bord.
        let zoneCode = null;
        const hasCoords = application.lat != null && application.lng != null;
        if (hasCoords) {
          try {
            const zone = await findZoneForPoint(pool, Number(application.lat), Number(application.lng));
            zoneCode = zone?.code || null;
          } catch {
            // pas bloquant — le livreur mettra à jour sa position depuis son tableau de bord
          }
        }

        await conn.query(
          `INSERT INTO livreur_profiles
             (user_id, country_code, city, id_document_url, id_document_type, photo_url,
              last_lat, last_lng, last_location_at, zone_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newUserId,
            application.country_code,
            application.city || null,
            application.id_document_url || null,
            application.id_document_type || null,
            application.photo_url || null,
            hasCoords ? application.lat : null,
            hasCoords ? application.lng : null,
            hasCoords ? new Date() : null,
            zoneCode,
          ]
        );
      } else {
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
      }

      await conn.query(
        `UPDATE vendor_applications
            SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW()
          WHERE id = ?`,
        [req.user.id, id]
      );

      await conn.commit();

      let whatsappSent = false;
      if (application.applicant_type === "LIVREUR") {
        // ✅ Non bloquant : le compte reste créé même si Twilio est
        // indisponible — l'admin garde la main pour recontacter manuellement.
        try {
          await sendWhatsAppMessage(
            application.contact_phone,
            buildLivreurApprovalWhatsAppMessage({
              legalName: application.legal_name,
              password,
              idDocumentType: application.id_document_type,
            })
          );
          whatsappSent = true;
        } catch (e) {
          console.error(
            "PATCH /api/vendor-applications/:id/approve — envoi WhatsApp échoué:",
            e?.message || e
          );
        }
      }

      res.json({ ok: true, user_id: newUserId, whatsapp_sent: whatsappSent });
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
