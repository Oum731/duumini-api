// src/routes/products.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const { getPool } = require("../lib/db");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { authRequired, requireRole, isVendor } = require("../middlewares/auth");

const router = express.Router();

/* =========================
 * Upload local (multipart)
 * ========================= */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const dest = path.join(
      UPLOAD_DIR,
      "products",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0")
    );
    ensureDirSync(dest);
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const name = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}-${name}${ext || ".jpg"}`);
  },
});
const upload = multer({ storage });

function toPublicUrl(absPath) {
  // absPath: .../uploads/...
  // retourne un chemin web relatif /uploads/...
  const idx = absPath.lastIndexOf(path.sep + "uploads" + path.sep);
  if (idx >= 0) {
    const rel = absPath.slice(idx).replace(/\\/g, "/");
    return rel.startsWith("/") ? rel : `/${rel}`;
  }
  // fallback: fichier hors /uploads
  return null;
}

/* ----------------------------- Helpers ----------------------------- */
function normalizeChannel(channel) {
  const c = String(channel || "").toLowerCase();
  if (c === "african-food") return "african-food";
  if (c === "african-market") return "african-market";
  return null;
}

async function listProducts(pool, { limit, offset, channel }) {
  let where = "1=1";
  const params = [];

  if (channel === "african-food") {
    where = "p.sub_category = 'food'";
  } else if (channel === "african-market") {
    where = "(p.sub_category IS NULL OR p.sub_category <> 'food')";
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM products p WHERE ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT p.*,
            (SELECT url FROM product_images pi WHERE pi.product_id=p.id ORDER BY sort_order ASC, id ASC LIMIT 1) AS cover
     FROM products p
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { rows, total };
}

/* ----------------------------- Listing ----------------------------- */
async function listHandler(req, res, next) {
  const { page, pageSize, offset, limit } = getPagination(req);
  const channel = normalizeChannel(req.query.channel);
  const pool = getPool();
  try {
    const { rows, total } = await listProducts(pool, { limit, offset, channel });
    res.json({ items: rows, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    next(e);
  }
}
router.get("/", listHandler);
router.get(
  "/african-food",
  (req, _res, next) => { req.query.channel = "african-food"; next(); },
  listHandler
);
router.get(
  "/african-market",
  (req, _res, next) => { req.query.channel = "african-market"; next(); },
  listHandler
);

/* ----------------------------- Read one ----------------------------- */
router.get("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const pool = getPool();
  try {
    const [rows] = await pool.query(`SELECT * FROM products WHERE id=?`, [id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: "Not found" });

    const [images] = await pool.query(
      `SELECT id, url, sort_order FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    res.json({ ...product, images });
  } catch (e) { next(e); }
});

/* ----------------------------- Create (multipart) ----------------------------- */
// attend FormData: name, price, stock?, currency?, description?, sub_category?, category_id?, images[] (max 3)
router.post(
  "/",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 3),
  async (req, res, next) => {
    const {
      shop_id,             // peut venir via JWT/role vendeur ? sinon exiger côté Admin
      category_id,
      name,
      slug,
      price,
      currency,
      description,
      stock,
      is_featured,
      promo_eligible,
      sub_category,
    } = req.body || {};

    if (!shop_id || !name || price == null) {
      // Pour un vendeur, shop_id doit être son shop (vérifié dessous)
      return res.status(400).json({ error: "shop_id, name, price required" });
    }

    const sub =
      ["product", "food", "other"].includes(String(sub_category)) ? sub_category : "product";

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[shop]] = await conn.query(`SELECT owner_id FROM shops WHERE id=?`, [shop_id]);
      if (!shop) { conn.release(); return res.status(400).json({ error: "Invalid shop_id" }); }
      if (isVendor(req.user) && String(shop.owner_id) !== String(req.user.id)) {
        conn.release(); return res.status(403).json({ error: "Forbidden: not your shop" });
      }

      const makeSlug = () =>
        (slug && String(slug).trim())
        || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toLowerCase();

      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO products (shop_id, category_id, name, slug, price, currency, description, stock, is_featured, promo_eligible, sub_category)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          Number(shop_id),
          category_id ? Number(category_id) : null,
          name,
          makeSlug(),
          Number(price),
          currency || "MAD",
          description || null,
          stock != null ? Number(stock) : 0,
          is_featured ? 1 : 0,
          promo_eligible ? 1 : 0,
          sub,
        ]
      );
      const productId = r.insertId;

      // Images enregistrées par multer
      const files = Array.isArray(req.files) ? req.files : [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const webUrl = toPublicUrl(f.path);
        if (!webUrl) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [productId, webUrl, i]
        );
      }

      await conn.commit();

      // Temps réel (optionnel)
      try {
        const { getIO, emitToShops } = require("../ws");
        const io = getIO && getIO();
        if (io && emitToShops) emitToShops([shop_id], "product:created", { product_id: productId });
      } catch {}

      const channel = sub === "food" ? "african-food" : "african-market";
      res.status(201).json({ id: productId, channel });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      if (e && e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Duplicate slug" });
      }
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Update (multipart ou JSON) ----------------------------- */
// accepte soit multipart (images[] supplémentaires → remplacées via /:id/images si tu veux strict)
// soit JSON simple pour les champs texte/nombres
router.put(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 3),
  async (req, res, next) => {
    const id = Number(req.params.id);
    const {
      name, price, currency, description, stock,
      is_featured, promo_eligible, sub_category, category_id,
      replace_images, // "true" pour remplacer la galerie par les files envoyés
    } = req.body || {};

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`,
        [id]
      );
      if (!prod) { conn.release(); return res.status(404).json({ error: "Not found" }); }
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release(); return res.status(403).json({ error: "Forbidden" });
      }

      const sub =
        sub_category && ["product", "food", "other"].includes(String(sub_category))
          ? sub_category
          : null;

      await conn.query(
        `UPDATE products SET
           name = COALESCE(?, name),
           price = COALESCE(?, price),
           currency = COALESCE(?, currency),
           description = COALESCE(?, description),
           stock = COALESCE(?, stock),
           is_featured = COALESCE(?, is_featured),
           promo_eligible = COALESCE(?, promo_eligible),
           sub_category = COALESCE(?, sub_category),
           category_id = COALESCE(?, category_id)
         WHERE id=?`,
        [
          name ?? null,
          price != null ? Number(price) : null,
          currency ?? null,
          description ?? null,
          stock != null ? Number(stock) : null,
          is_featured === undefined ? null : (is_featured ? 1 : 0),
          promo_eligible === undefined ? null : (promo_eligible ? 1 : 0),
          sub,
          category_id != null ? Number(category_id) : null,
          id,
        ]
      );

      // Gestion images si multipart
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        const doReplace = String(replace_images || "").toLowerCase() === "true";
        if (doReplace) {
          await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
        }
        // Ajouter en fin
        const [[{ maxOrder }]] = await conn.query(
          `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM product_images WHERE product_id=?`,
          [id]
        );
        let start = (maxOrder ?? -1) + 1;
        for (let i = 0; i < files.length; i++) {
          const webUrl = toPublicUrl(files[i].path);
          if (!webUrl) continue;
          await conn.query(
            `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
            [id, webUrl, start + i]
          );
        }
      }

      // Temps réel (optionnel)
      try {
        const { getIO } = require("../ws");
        const io = getIO && getIO();
        if (io && io.broadcastToUser) io.broadcastToUser(prod.owner_id, "product:updated", { product_id: id });
      } catch {}

      res.json({ ok: true });
    } catch (e) { next(e); }
    finally { conn.release(); }
  }
);

/* ----------------------------- Replace images (JSON ou multipart) ----------------------------- */
router.put(
  "/:id/images",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  upload.array("images[]", 8),
  async (req, res, next) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`,
        [id]
      );
      if (!prod) { conn.release(); return res.status(404).json({ error: "Not found" }); }
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release(); return res.status(403).json({ error: "Forbidden" });
      }

      const bodyImages = Array.isArray(req.body?.images) ? req.body.images : [];
      const files = Array.isArray(req.files) ? req.files : [];

      await conn.beginTransaction();
      await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);

      // d’abord celles du body (URLs), puis les files uploadés
      let order = 0;
      for (const url of bodyImages) {
        const u = String(url || "").trim();
        if (!u) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [id, u, order++]
        );
      }
      for (let i = 0; i < files.length; i++) {
        const webUrl = toPublicUrl(files[i].path);
        if (!webUrl) continue;
        await conn.query(
          `INSERT INTO product_images (product_id, url, sort_order) VALUES (?,?,?)`,
          [id, webUrl, order++]
        );
      }

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

/* ----------------------------- Delete ----------------------------- */
router.delete(
  "/:id",
  authRequired,
  requireRole("VENDEUR", "ADMIN"),
  async (req, res, next) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      const [[prod]] = await conn.query(
        `SELECT p.*, s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?`,
        [id]
      );
      if (!prod) { conn.release(); return res.status(404).json({ error: "Not found" }); }
      if (isVendor(req.user) && String(prod.owner_id) !== String(req.user.id)) {
        conn.release(); return res.status(403).json({ error: "Forbidden" });
      }

      // récupérer images pour suppression locale
      const [imgs] = await conn.query(
        `SELECT url FROM product_images WHERE product_id=? ORDER BY sort_order ASC, id ASC`,
        [id]
      );

      await conn.beginTransaction();
      await conn.query(`DELETE FROM product_images WHERE product_id=?`, [id]);
      await conn.query(`DELETE FROM products WHERE id=?`, [id]);
      await conn.commit();

      // supprimer fichiers locaux si hébergés chez nous
      for (const it of imgs) {
        const u = String(it.url || "");
        if (!u.startsWith("/uploads/")) continue;
        const abs = path.join(process.cwd(), u.replace(/^\//, "").replace(/\//g, path.sep));
        fs.promises.unlink(abs).catch(() => {});
      }

      // temps réel (optionnel)
      try {
        const { getIO } = require("../ws");
        const io = getIO && getIO();
        if (io && io.broadcastToUser) io.broadcastToUser(prod.owner_id, "product:deleted", { product_id: id });
      } catch {}

      res.json({ ok: true });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      next(e);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
