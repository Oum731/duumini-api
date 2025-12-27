// src/routes/orders.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole, isAdmin, isVendor } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { sendWhatsAppOrderConfirmation } = require("../services/twilio");
const { env } = require("../lib/env");

const router = Router();

/* =========================
 * CONFIG WHATSAPP ADMIN (NUMÉRO EN DUR)
 * =======================*/

// ✅ Mets ici le numéro admin (en dur)
const ADMIN_WHATSAPP_HARDCODED_RAW = "+212623677884";

// ✅ Normalise: accepte "+212..." ou "whatsapp:+212..." (Twilio WhatsApp)
const ADMIN_WHATSAPP = String(ADMIN_WHATSAPP_HARDCODED_RAW || "")
  .trim()
  .startsWith("whatsapp:")
  ? String(ADMIN_WHATSAPP_HARDCODED_RAW).trim()
  : `whatsapp:${String(ADMIN_WHATSAPP_HARDCODED_RAW).trim()}`;

/* =========================
 * Helpers
 * =======================*/

function safeParseJSON(maybe) {
  if (!maybe) return null;
  if (typeof maybe === "object") return maybe;
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}

function buildAddressObj(input = {}) {
  const ville = input?.ville ?? input?.city ?? null;
  const commune = input?.commune ?? null;
  const quartier = input?.quartier ?? input?.district ?? null;
  const gps =
    input?.gps && typeof input.gps === "object"
      ? { lat: Number(input.gps.lat), lng: Number(input.gps.lng) }
      : null;

  return {
    city: ville,
    commune,
    district: quartier,
    gps,
  };
}

function buildGeoLink(gps) {
  if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number") return null;
  return `https://maps.google.com/?q=${gps.lat},${gps.lng}`;
}

function normPhone(p) {
  const raw = String(p || "").replace(/\s+/g, "");
  if (!raw) return null;
  if (raw.startsWith("+")) return raw;
  if (raw.startsWith("00")) return "+" + raw.slice(2);
  if (/^0\d{9,}$/.test(raw)) return "+212" + raw.slice(1);
  return raw;
}

function buildContactFromUser(u) {
  if (!u) return { first_name: null, last_name: null, phone: null };
  return {
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    phone: normPhone(u.phone) || null,
  };
}

function buildContactFromPayload(c = {}) {
  const rawFirst = c?.first_name ?? null;
  const rawLast = c?.last_name ?? null;
  const rawName = c?.name ?? null;

  let first_name = rawFirst;
  let last_name = rawLast;

  if (!first_name && !last_name && rawName) {
    const parts = String(rawName).trim().split(/\s+/);
    if (parts.length === 1) {
      first_name = parts[0];
      last_name = null;
    } else {
      first_name = parts[0];
      last_name = parts.slice(1).join(" ");
    }
  }

  const phone = normPhone(c?.phone);
  return {
    first_name: first_name || null,
    last_name: last_name || null,
    phone: phone || null,
  };
}

function buildDisplayCode(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return String(id ?? "").toUpperCase();
  return n.toString(36).toUpperCase();
}

/**
 * ✅ Commission: on se base sur p.sub_category_slug (nouveau) ou fallback food/non-food
 */
function computeCommissionForLine(clientUnitPrice, qty, subSlug) {
  const totalClientLine = Number(clientUnitPrice || 0) * Number(qty || 1);
  const sub = String(subSlug || "").trim().toLowerCase();
  const rate = sub === "food" ? 0.18 : 0.11;
  return +(+totalClientLine * rate).toFixed(2);
}

/**
 * ✅ Promo: même logique, mais sur slug (nouveau)
 */
function isPromoProductRow(p) {
  const isFood = String(p?.sub_category_slug || "").trim().toLowerCase() === "food";
  return (
    !isFood &&
    Number(p?.promo_eligible ?? 0) === 1 &&
    Number(p?.promo_discount_value ?? 0) > 0
  );
}

function stripCommissionFromOrderRow(row, user) {
  if (!row) return row;
  if (isAdmin(user) || isVendor(user)) return row;
  const { commission_duumini, ...rest } = row;
  return rest;
}

async function getOrderWithPerm(conn, id, user) {
  const [[orderRaw]] = await conn.query(`SELECT * FROM orders WHERE id=?`, [id]);
  if (!orderRaw) return { status: 404, error: "Not found" };

  if (!isAdmin(user)) {
    if (isVendor(user)) {
      const [[own]] = await conn.query(
        `
        SELECT 1
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN shops s    ON s.id = p.shop_id
        WHERE oi.order_id = ? AND s.owner_id = ?
        LIMIT 1
        `,
        [id, user.id]
      );
      if (!own) return { status: 403, error: "Forbidden" };
    } else {
      if (String(orderRaw.user_id) !== String(user.id)) return { status: 403, error: "Forbidden" };
    }
  }

  const order = stripCommissionFromOrderRow(orderRaw, user);

  const [items] = await conn.query(
    `
    SELECT 
      oi.*,
      p.name AS product_name,
      pv.size  AS variant_size,
      pv.color AS variant_color,
      pv.sku   AS variant_sku,
      (
        SELECT pi.url
        FROM product_images pi
        WHERE pi.product_id = oi.product_id
        ORDER BY pi.sort_order ASC, pi.id ASC
        LIMIT 1
      ) AS product_cover
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN product_variants pv ON pv.id = oi.variant_id
    WHERE oi.order_id = ?
    ORDER BY oi.id ASC
    `,
    [id]
  );

  return { status: 200, order, items };
}

/* ========= Helpers notifications commande ========= */

async function getAdminUserIds() {
  const [rows] = await getPool().query(
    `SELECT id 
       FROM users 
      WHERE role = 'ADMIN'
        AND (is_active = 1 OR is_active IS NULL)`
  );
  return rows.map((r) => r.id);
}

async function getVendorsForOrder(orderId) {
  const [rows] = await getPool().query(
    `
    SELECT DISTINCT u.id AS user_id
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN shops   s ON s.id = p.shop_id
      JOIN users   u ON u.id = s.owner_id
     WHERE oi.order_id = ?
       AND (u.is_active = 1 OR u.is_active IS NULL)
    `,
    [orderId]
  );
  return rows.map((r) => r.user_id);
}

async function enqueueOrderCreatedNotifications(orderId, total, currency) {
  const [adminIds, vendorIds] = await Promise.all([getAdminUserIds(), getVendorsForOrder(orderId)]);
  const allUserIds = Array.from(new Set([...adminIds, ...vendorIds]));
  if (!allUserIds.length) return;

  const cur = (currency || "MAD").toUpperCase();
  const displayCode = buildDisplayCode(orderId);

  const payloadObj = {
    title: `Nouvelle commande ${displayCode}`,
    body: `Un client vient de passer une commande ${displayCode} de ${total} ${cur}.`,
    order_id: orderId,
    display_code: displayCode,
    total,
    currency: cur,
    status: "OPEN",
  };

  const payload = JSON.stringify(payloadObj);
  const values = allUserIds.map((uid) => [uid, "ORDER_CREATED", payload, "queued"]);

  await getPool().query(
    `
    INSERT INTO notification_queue (user_id, type, payload, status)
    VALUES ?
    `,
    [values]
  );
}

async function enqueueOrderStatusForClient(orderId, status) {
  const [[row]] = await getPool().query(
    `SELECT user_id, total, currency
       FROM orders
      WHERE id = ?
      LIMIT 1`,
    [orderId]
  );

  if (!row || !row.user_id) return;

  const cur = (row.currency || "MAD").toUpperCase();
  const total = Number(row.total || 0);
  const displayCode = buildDisplayCode(orderId);

  const payloadObj = {
    title: `Mise à jour commande ${displayCode}`,
    body: `Le statut de votre commande ${displayCode} est passé à ${status}.`,
    order_id: orderId,
    display_code: displayCode,
    status,
    total,
    currency: cur,
  };

  await getPool().query(
    `
    INSERT INTO notification_queue (user_id, type, payload, status)
    VALUES (?, 'ORDER_STATUS', ?, 'queued')
    `,
    [row.user_id, JSON.stringify(payloadObj)]
  );
}

/* =========================
 * WhatsApp helper (réutilisé connecté + invité)
 * -> envoie toujours au numéro admin en dur
 * =======================*/

async function sendAdminWhatsAppForOrder({
  pool,
  orderId,
  displayCode,
  orderTotal,
  currency,
  addressObj,
  contactObj,
  items,
}) {
  const hasFrom = !!(env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_FROM);
  const isProd = String(env.NODE_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";

  if (!hasFrom) {
    console.warn("[WhatsApp] skip: TWILIO_WHATSAPP_FROM missing");
    return;
  }
  if (!ADMIN_WHATSAPP || !String(ADMIN_WHATSAPP).trim().startsWith("whatsapp:")) {
    console.warn("[WhatsApp] skip: ADMIN_WHATSAPP invalid");
    return;
  }
  if (!isProd) {
    console.warn("[WhatsApp] NODE_ENV != production -> Twilio DEV_MODE (no real send)");
  }

  const fullName =
    `${contactObj?.first_name || ""} ${contactObj?.last_name || ""}`.trim() || "Client Duumini";

  // ✅ Détails: inclut variante si présente
  let details = "";
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        oi.qty,
        oi.unit_price,
        p.name AS product_name,
        pv.size AS v_size,
        pv.color AS v_color
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC
      `,
      [orderId]
    );

    if (rows && rows.length) {
      details = rows
        .map((r) => {
          const label = r.product_name || "Produit";
          const vtxt = [r.v_size, r.v_color].filter(Boolean).join(" / ");
          const suffix = vtxt ? ` (${vtxt})` : "";
          const qty = Number(r.qty || 1);
          const price = Number(r.unit_price || 0);
          return `• ${label}${suffix} ×${qty} — ${price} ${currency || "MAD"}`;
        })
        .join("\n");
    }
  } catch (e) {
    console.error("[WhatsApp] details query failed", e?.message || e);
    if (Array.isArray(items) && items.length) {
      details = items
        .map((it) => {
          const label = it?.name || `Produit #${it?.product_id || ""}`.trim();
          const qty = it?.qty || 1;
          const price =
            it?.price != null ? `${it.price} ${(currency || "MAD").toUpperCase()}` : "";
          return `• ${label} ×${qty}${price ? ` — ${price}` : ""}`;
        })
        .join("\n");
    }
  }

  // ✅ Première image: depuis la BDD
  let firstProductImage = null;
  try {
    const [[rowImg]] = await pool.query(
      `
      SELECT pi.url
      FROM order_items oi
      JOIN product_images pi ON pi.product_id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC, pi.sort_order ASC, pi.id ASC
      LIMIT 1
      `,
      [orderId]
    );
    if (rowImg && rowImg.url) firstProductImage = rowImg.url;
  } catch (imgErr) {
    console.error(`[WhatsApp] image query failed order #${orderId}`, imgErr?.message || imgErr);
  }

  console.log("[WhatsApp] sending order", { orderId, to: ADMIN_WHATSAPP });

  try {
    await sendWhatsAppOrderConfirmation({
      to: ADMIN_WHATSAPP,
      name: fullName,
      orderId,
      displayCode,
      total: orderTotal,
      ville: addressObj?.city || null,
      commune: addressObj?.commune || null,
      quartier: addressObj?.district || null,
      phone: contactObj?.phone || null,
      details,
      imageUrl: firstProductImage || null,
    });

    console.log("[WhatsApp] sent OK", { orderId });
  } catch (errWa) {
    console.error(`[WhatsApp] FAIL order #${orderId}`, {
      message: errWa?.message,
      code: errWa?.code,
      status: errWa?.status,
      moreInfo: errWa?.moreInfo,
    });
  }
}

/* =========================
 * STOCK helpers (produit vs variante)
 * =======================*/

function normQty(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseVariantId(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

async function lockProductForItem(conn, productId) {
  const [[p]] = await conn.query(
    `
    SELECT
      p.id,
      p.price,
      p.stock,
      p.shop_id,
      p.promo_eligible,
      p.promo_discount_value,
      sc.slug AS sub_category_slug
    FROM products p
    LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
    WHERE p.id=? FOR UPDATE
    `,
    [productId]
  );
  return p || null;
}

async function lockVariantForItem(conn, productId, variantId) {
  const [[v]] = await conn.query(
    `
    SELECT
      pv.id,
      pv.product_id,
      pv.stock,
      pv.price_override,
      pv.is_active,
      pv.size,
      pv.color,
      pv.sku
    FROM product_variants pv
    WHERE pv.id=? AND pv.product_id=? FOR UPDATE
    `,
    [variantId, productId]
  );
  return v || null;
}

/* =========================
 * List (admin : tout / client : ses commandes)
 * =======================*/
router.get("/", authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const mine = req.query.mine === "1" || req.query.mine === "true";
  const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : null;
  const hasStatus = rawStatus && rawStatus !== "ALL";

  try {
    if (mine) {
      const params = [req.user.id];
      let where = "o.user_id = ?";

      if (hasStatus) {
        where += " AND o.status = ?";
        params.push(rawStatus);
      }

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM orders o WHERE ${where}`,
        params
      );

      const [rowsRaw] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
          (
            SELECT SUM(oi2.qty * oi2.unit_price)
            FROM order_items oi2
            WHERE oi2.order_id = o.id
          ) AS items_amount,
          (
            SELECT pi.url
            FROM order_items oi
            JOIN product_images pi ON pi.product_id = oi.product_id
            WHERE oi.order_id = o.id
            ORDER BY oi.id ASC, pi.sort_order ASC, pi.id ASC
            LIMIT 1
          ) AS first_product_cover
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      const rows = rowsRaw.map((r) => stripCommissionFromOrderRow(r, req.user));

      const items = rows.map((r) => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          contactFromOrder &&
          (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone)
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        const geo_link = r.geo_link || buildGeoLink(address?.gps);

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || "MAD").toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }

    if (isAdmin(req.user)) {
      let where = "1=1";
      const params = [];

      if (hasStatus) {
        where += " AND o.status = ?";
        params.push(rawStatus);
      }

      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders o WHERE ${where}`, params);

      const [rowsRaw] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
          (
            SELECT SUM(oi2.qty * oi2.unit_price)
            FROM order_items oi2
            WHERE oi2.order_id = o.id
          ) AS items_amount,
          (
            SELECT pi.url
            FROM order_items oi
            JOIN product_images pi ON pi.product_id = oi.product_id
            WHERE oi.order_id = o.id
            ORDER BY oi.id ASC, pi.sort_order ASC, pi.id ASC
            LIMIT 1
          ) AS first_product_cover
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      const items = rowsRaw.map((r) => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          contactFromOrder &&
          (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone)
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        const geo_link = r.geo_link || buildGeoLink(address?.gps);

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || "MAD").toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }

    if (isVendor(req.user)) {
      let where = "s.owner_id = ?";
      const params = [req.user.id];

      if (hasStatus) {
        where += " AND o.status = ?";
        params.push(rawStatus);
      }

      const [[{ total }]] = await pool.query(
        `
        SELECT COUNT(DISTINCT o.id) AS total
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        JOIN shops s        ON s.id = p.shop_id
        WHERE ${where}
        `,
        params
      );

      const [rowsRaw] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
          (
            SELECT SUM(oi_all.qty * oi_all.unit_price)
            FROM order_items oi_all
            WHERE oi_all.order_id = o.id
          ) AS items_amount,
          (
            SELECT pi.url
            FROM order_items oi2
            JOIN products p2       ON p2.id = oi2.product_id
            JOIN shops s2          ON s2.id = p2.shop_id
            JOIN product_images pi ON pi.product_id = p2.id
            WHERE oi2.order_id = o.id
              AND s2.owner_id = ?
            ORDER BY oi2.id ASC, pi.sort_order ASC, pi.id ASC
            LIMIT 1
          ) AS first_product_cover
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        JOIN shops s        ON s.id = p.shop_id
        LEFT JOIN users u   ON u.id = o.user_id
        WHERE ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      const items = rowsRaw.map((r) => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          contactFromOrder &&
          (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone)
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        const geo_link = r.geo_link || buildGeoLink(address?.gps);

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || "MAD").toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }

    const params = [req.user.id];
    let where = "o.user_id = ?";

    if (hasStatus) {
      where += " AND o.status = ?";
      params.push(rawStatus);
    }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders o WHERE ${where}`, params);

    const [rowsRaw] = await pool.query(
      `
      SELECT 
        o.*,
        u.first_name AS u_first,
        u.last_name  AS u_last,
        u.phone      AS u_phone,
        (
          SELECT SUM(oi2.qty * oi2.unit_price)
          FROM order_items oi2
          WHERE oi2.order_id = o.id
        ) AS items_amount,
        (
          SELECT pi.url
          FROM order_items oi
          JOIN product_images pi ON pi.product_id = oi.product_id
          WHERE oi.order_id = o.id
          ORDER BY oi.id ASC, pi.sort_order ASC, pi.id ASC
          LIMIT 1
        ) AS first_product_cover
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const rows = rowsRaw.map((r) => stripCommissionFromOrderRow(r, req.user));

    const items = rows.map((r) => {
      const address = safeParseJSON(r.address);
      const contactFromOrder = safeParseJSON(r.contact);
      const contact =
        contactFromOrder &&
        (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone)
          ? contactFromOrder
          : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

      const geo_link = r.geo_link || buildGeoLink(address?.gps);

      const itemsAmount = Number(r.items_amount || 0);
      const totalAmount = Number(r.total || itemsAmount);
      const deliveryFee = Math.max(0, totalAmount - itemsAmount);
      const currency = (r.currency || "MAD").toUpperCase();

      return {
        ...r,
        display_code: buildDisplayCode(r.id),
        address,
        contact,
        geo_link,
        totals: {
          items_amount: itemsAmount,
          delivery_fee: deliveryFee,
          amount: totalAmount,
          currency,
        },
      };
    });

    return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Create order (UTILISATEUR CONNECTÉ)
 * ✅ support variantes: items[].variant_id (optionnel)
 * =======================*/
router.post("/", authRequired, async (req, res) => {
  const { contact = null, address = {}, delivery = {}, items = [], totals = {} } = req.body || {};

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items[] required" });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    let contactObj = contact ? buildContactFromPayload(contact) : null;
    if (!contactObj || (!contactObj.first_name && !contactObj.last_name && !contactObj.phone)) {
      contactObj = buildContactFromUser(req.user);
    }

    let itemsAmount = 0;
    let totalCommission = 0;
    const cleanItems = [];
    let firstFoodShopId = null;
    let hasPromo = false;

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = normQty(it?.qty);
      const variant_id = parseVariantId(it?.variant_id);

      if (!product_id || !qty) {
        const err = new Error("product_id & qty required");
        err.statusCode = 400;
        err.payload = {
          code: "INVALID_ITEM",
          message: "Un ou plusieurs produits sont invalides dans votre panier.",
        };
        throw err;
      }

      const p = await lockProductForItem(conn, product_id);
      if (!p) {
        const err = new Error("Product not found: " + product_id);
        err.statusCode = 400;
        err.payload = {
          code: "PRODUCT_NOT_FOUND",
          message: "Un produit de votre panier n'est plus disponible.",
          product_id,
        };
        throw err;
      }

      const isFood = String(p.sub_category_slug || "").trim().toLowerCase() === "food";
      if (isFood) {
        const shopId = p.shop_id != null ? Number(p.shop_id) : null;
        if (shopId != null) {
          if (firstFoodShopId == null) firstFoodShopId = shopId;
          else if (firstFoodShopId !== shopId) {
            const err = new Error("MULTIPLE_FOOD_SHOPS_NOT_ALLOWED");
            err.statusCode = 400;
            err.payload = {
              code: "MULTIPLE_FOOD_SHOPS_NOT_ALLOWED",
              message:
                "Vous ne pouvez pas commander dans plusieurs restaurants (catégorie Food) en même temps. Terminez ou videz votre panier avant de changer de restaurant.",
            };
            throw err;
          }
        }
      }

      if (isPromoProductRow(p)) hasPromo = true;

      let unit_price = Number(p.price || 0);
      let stockSource = "PRODUCT";
      let current_stock = p.stock;
      let variant_meta = null;

      if (variant_id) {
        const v = await lockVariantForItem(conn, product_id, variant_id);
        if (!v || Number(v.is_active || 0) !== 1) {
          const err = new Error("VARIANT_NOT_FOUND");
          err.statusCode = 400;
          err.payload = {
            code: "VARIANT_NOT_FOUND",
            message: "Une variante choisie n'est plus disponible.",
            product_id,
            variant_id,
          };
          throw err;
        }

        unit_price =
          v.price_override != null && v.price_override !== ""
            ? Number(v.price_override)
            : Number(p.price || 0);

        stockSource = "VARIANT";
        current_stock = v.stock;
        variant_meta = {
          variant_id: v.id,
          size: v.size || null,
          color: v.color || null,
          sku: v.sku || null,
        };
      }

      const lineCommission = computeCommissionForLine(unit_price, qty, p.sub_category_slug);

      cleanItems.push({
        product_id: p.id,
        qty,
        unit_price,
        stockSource,
        current_stock,
        variant_id: variant_id || null,
        variant_meta,
      });

      itemsAmount += unit_price * qty;
      totalCommission += lineCommission;
    }

    const deliveryFee = hasPromo ? 0 : Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || "MAD").toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    const [r] = await conn.query(
      `
      INSERT INTO orders (user_id, status, address, contact, geo_link, total, commission_duumini, currency, created_at, updated_at)
      VALUES (?, 'OPEN', ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        req.user.id,
        JSON.stringify(addressObj),
        JSON.stringify(contactObj),
        geoLink,
        orderTotal,
        +totalCommission.toFixed(2),
        currency,
      ]
    );

    const orderId = r.insertId;
    const displayCode = buildDisplayCode(orderId);

    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, qty, unit_price) VALUES (?,?,?,?,?)`,
        [orderId, it.product_id, it.variant_id, it.qty, it.unit_price]
      );
    }

    for (const it of cleanItems) {
      if (it.current_stock === null || it.current_stock === undefined) continue;

      const currentStock = Number(it.current_stock || 0);
      const newStock = currentStock - Number(it.qty || 0);

      if (newStock < 0) {
        const err = new Error("STOCK_INSUFFICIENT");
        err.statusCode = 400;
        err.payload = {
          code: "STOCK_INSUFFICIENT",
          message: "La quantité demandée n'est plus disponible pour un des produits de votre panier.",
          product_id: it.product_id,
          variant_id: it.variant_id || null,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      if (it.stockSource === "VARIANT" && it.variant_id) {
        await conn.query(`UPDATE product_variants SET stock=? WHERE id=?`, [newStock, it.variant_id]);
      } else {
        await conn.query(`UPDATE products SET stock=? WHERE id=?`, [newStock, it.product_id]);
      }
    }

    await conn.commit();

    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error("[Notify] enqueueOrderCreatedNotifications failed", eNot);
    }

    try {
      const { notifyUser } = require("../services/notify");
      await notifyUser(req.user.id, "ORDER_CREATED", {
        order_id: orderId,
        display_code: displayCode,
        total: orderTotal,
      });
    } catch {}

    // ✅ WhatsApp admin (après commit, non bloquant)
    sendAdminWhatsAppForOrder({
      pool,
      orderId,
      displayCode,
      orderTotal,
      currency,
      addressObj,
      contactObj,
      items,
    }).catch(() => {});

    res.status(201).json({
      id: orderId,
      display_code: displayCode,
      status: "OPEN",
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    if (e && e.statusCode === 400 && e.payload) return res.status(400).json(e.payload);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Create order invité (SANS AUTH)
 * ✅ support variantes: items[].variant_id (optionnel)
 * =======================*/
router.post("/guest", async (req, res) => {
  const { contact = {}, address = {}, delivery = {}, items = [], totals = {} } = req.body || {};

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items[] required" });

  const contactObj = buildContactFromPayload(contact);
  if (!contactObj.phone) {
    return res.status(400).json({
      code: "PHONE_REQUIRED",
      message: "Un numéro de téléphone est obligatoire pour passer une commande.",
    });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    let itemsAmount = 0;
    let totalCommission = 0;
    const cleanItems = [];
    let firstFoodShopId = null;
    let hasPromo = false;

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = normQty(it?.qty);
      const variant_id = parseVariantId(it?.variant_id);

      if (!product_id || !qty) {
        const err = new Error("product_id & qty required");
        err.statusCode = 400;
        err.payload = {
          code: "INVALID_ITEM",
          message: "Un ou plusieurs produits sont invalides dans votre panier.",
        };
        throw err;
      }

      const p = await lockProductForItem(conn, product_id);
      if (!p) {
        const err = new Error("Product not found: " + product_id);
        err.statusCode = 400;
        err.payload = {
          code: "PRODUCT_NOT_FOUND",
          message: "Un produit de votre panier n'est plus disponible.",
          product_id,
        };
        throw err;
      }

      const isFood = String(p.sub_category_slug || "").trim().toLowerCase() === "food";
      if (isFood) {
        const shopId = p.shop_id != null ? Number(p.shop_id) : null;
        if (shopId != null) {
          if (firstFoodShopId == null) firstFoodShopId = shopId;
          else if (firstFoodShopId !== shopId) {
            const err = new Error("MULTIPLE_FOOD_SHOPS_NOT_ALLOWED");
            err.statusCode = 400;
            err.payload = {
              code: "MULTIPLE_FOOD_SHOPS_NOT_ALLOWED",
              message:
                "Vous ne pouvez pas commander dans plusieurs restaurants en même temps. Terminez ou videz votre panier avant de changer de restaurant.",
            };
            throw err;
          }
        }
      }

      if (isPromoProductRow(p)) hasPromo = true;

      let unit_price = Number(p.price || 0);
      let stockSource = "PRODUCT";
      let current_stock = p.stock;

      if (variant_id) {
        const v = await lockVariantForItem(conn, product_id, variant_id);
        if (!v || Number(v.is_active || 0) !== 1) {
          const err = new Error("VARIANT_NOT_FOUND");
          err.statusCode = 400;
          err.payload = {
            code: "VARIANT_NOT_FOUND",
            message: "Une variante choisie n'est plus disponible.",
            product_id,
            variant_id,
          };
          throw err;
        }

        unit_price =
          v.price_override != null && v.price_override !== ""
            ? Number(v.price_override)
            : Number(p.price || 0);

        stockSource = "VARIANT";
        current_stock = v.stock;
      }

      const lineCommission = computeCommissionForLine(unit_price, qty, p.sub_category_slug);

      cleanItems.push({
        product_id: p.id,
        qty,
        unit_price,
        stockSource,
        current_stock,
        variant_id: variant_id || null,
      });

      itemsAmount += unit_price * qty;
      totalCommission += lineCommission;
    }

    const deliveryFee = hasPromo ? 0 : Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || "MAD").toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    const [r] = await conn.query(
      `
      INSERT INTO orders (user_id, status, address, contact, geo_link, total, commission_duumini, currency, created_at, updated_at)
      VALUES (NULL, 'OPEN', ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        JSON.stringify(addressObj),
        JSON.stringify(contactObj),
        geoLink,
        orderTotal,
        +totalCommission.toFixed(2),
        currency,
      ]
    );

    const orderId = r.insertId;
    const displayCode = buildDisplayCode(orderId);

    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, qty, unit_price) VALUES (?,?,?,?,?)`,
        [orderId, it.product_id, it.variant_id, it.qty, it.unit_price]
      );
    }

    for (const it of cleanItems) {
      if (it.current_stock === null || it.current_stock === undefined) continue;

      const currentStock = Number(it.current_stock || 0);
      const newStock = currentStock - Number(it.qty || 0);

      if (newStock < 0) {
        const err = new Error("STOCK_INSUFFICIENT");
        err.statusCode = 400;
        err.payload = {
          code: "STOCK_INSUFFICIENT",
          message: "La quantité demandée n'est plus disponible pour un des produits de votre panier.",
          product_id: it.product_id,
          variant_id: it.variant_id || null,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      if (it.stockSource === "VARIANT" && it.variant_id) {
        await conn.query(`UPDATE product_variants SET stock=? WHERE id=?`, [newStock, it.variant_id]);
      } else {
        await conn.query(`UPDATE products SET stock=? WHERE id=?`, [newStock, it.product_id]);
      }
    }

    await conn.commit();

    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error("[Notify] enqueueOrderCreatedNotifications failed (guest)", eNot);
    }

    // ✅ WhatsApp admin (après commit, non bloquant)
    sendAdminWhatsAppForOrder({
      pool,
      orderId,
      displayCode,
      orderTotal,
      currency,
      addressObj,
      contactObj,
      items,
    }).catch(() => {});

    res.status(201).json({
      id: orderId,
      display_code: displayCode,
      status: "OPEN",
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    if (e && e.statusCode === 400 && e.payload) return res.status(400).json(e.payload);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Get one order (detail + items)
 * =======================*/
router.get("/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const conn = await getPool().getConnection();

  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    const o = result.order;
    const addr = safeParseJSON(o.address);

    const [[u]] = await conn.query(
      "SELECT first_name, last_name, phone FROM users WHERE id=? LIMIT 1",
      [o.user_id]
    );

    const contactFromOrder = safeParseJSON(o.contact);
    const contact =
      contactFromOrder &&
      (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone)
        ? contactFromOrder
        : buildContactFromUser(u);

    const itemsAmount = result.items.reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.qty || 1),
      0
    );

    const totalAmount = Number(o.total || itemsAmount);
    const deliveryFee = Math.max(0, totalAmount - itemsAmount);
    const currency = (o.currency || "MAD").toUpperCase();

    res.json({
      ...o,
      display_code: buildDisplayCode(o.id),
      contact,
      address: addr,
      items: result.items,
      totals: { items_amount: itemsAmount, delivery_fee: deliveryFee, amount: totalAmount, currency },
      geo_link: o.geo_link || buildGeoLink(addr?.gps) || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Update status
 * =======================*/
router.put("/:id/status", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ["OPEN", "PREPARATION", "DELIVERY", "DONE", "CANCELLED"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid status" });

  const pool = getPool();

  try {
    if (!isAdmin(req.user)) {
      const [[row]] = await pool.query(
        `
        SELECT s.owner_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        JOIN shops s ON s.id = p.shop_id
        WHERE o.id = ?
        LIMIT 1
        `,
        [id]
      );

      if (!row) return res.status(404).json({ error: "Not found" });
      if (!(isVendor(req.user) && String(row.owner_id) === String(req.user.id))) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    await pool.query(`UPDATE orders SET status=?, updated_at=NOW() WHERE id=?`, [status, id]);

    const [[order]] = await pool.query(`SELECT user_id FROM orders WHERE id=?`, [id]);
    if (order && order.user_id) {
      try {
        await enqueueOrderStatusForClient(id, status);
      } catch (eQueue) {
        console.error("[Notify] enqueueOrderStatusForClient failed", eQueue);
      }

      try {
        const { notifyUser } = require("../services/notify");
        await notifyUser(order.user_id, "ORDER_STATUS", {
          order_id: id,
          display_code: buildDisplayCode(id),
          status,
        });
      } catch {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Annulation par l’acheteur (ou admin)
 * ✅ RESTOCK: on remet le stock sur variante/produit
 * =======================*/
router.post("/:id/cancel", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) {
      await conn.rollback();
      return res.status(result.status).json({ error: result.error });
    }

    const order = result.order;
    const blocked = ["DONE", "CANCELLED"].includes(order.status || "");
    if (blocked && !isAdmin(req.user)) {
      await conn.rollback();
      return res.status(409).json({ error: "Cannot cancel at this stage" });
    }

    const [items] = await conn.query(
      `SELECT product_id, variant_id, qty FROM order_items WHERE order_id=? ORDER BY id ASC`,
      [id]
    );

    for (const it of items) {
      const qty = Number(it.qty || 0);
      if (!qty) continue;

      if (it.variant_id) {
        await conn.query(`UPDATE product_variants SET stock = COALESCE(stock,0) + ? WHERE id=?`, [
          qty,
          it.variant_id,
        ]);
      } else if (it.product_id) {
        await conn.query(`UPDATE products SET stock = COALESCE(stock,0) + ? WHERE id=?`, [
          qty,
          it.product_id,
        ]);
      }
    }

    await conn.query(`UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE id=?`, [id]);

    await conn.commit();

    try {
      if (order.user_id) {
        await enqueueOrderStatusForClient(id, "CANCELLED");

        const { notifyUser } = require("../services/notify");
        await notifyUser(order.user_id, "ORDER_STATUS", {
          order_id: id,
          display_code: buildDisplayCode(id),
          status: "CANCELLED",
        });
      }
    } catch (eNot) {
      console.error("[Notify] ORDER_STATUS cancel failed", eNot);
    }

    res.json({ ok: true, status: "CANCELLED" });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
