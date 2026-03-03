// src/routes/orders.js
const { Router } = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

const { getPool } = require("../lib/db");
const { authRequired, isAdmin, isVendor } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");
const { env } = require("../lib/env");
const {
  sendWhatsAppOrderConfirmation,
  sendWhatsAppReceiptToClient,
} = require("../services/twilio");

const router = Router();

/* =========================
 * ✅ DUUMINI COMMISSION CONFIG
 * =======================*/
const DUUMINI_COMMISSION_RATE = 0.09; // ✅ 9% sur tout (food/market/fashion)

/* =========================
 * CONFIG WHATSAPP ADMIN
 * =======================*/
const ADMIN_WHATSAPP_HARDCODED_RAW = "+212623677884";
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

  return { city: ville, commune, district: quartier, gps };
}

function buildGeoLink(gps) {
  if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number")
    return null;
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

function normCommission(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  return +n.toFixed(2);
}

function stripCommissionFromOrderRow(row, user) {
  if (!row) return row;
  if (isAdmin(user) || isVendor(user)) return row;
  const { commission_duumini, ...rest } = row;
  return rest;
}

function isCancelledStatus(s) {
  return (
    String(s || "")
      .trim()
      .toUpperCase() === "CANCELLED"
  );
}

/** ✅ Commission Duumini = 9% uniquement sur les PRODUITS (pas livraison) */
function computeDuuminiCommission(itemsAmount) {
  const base = Number(itemsAmount || 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return +(+base * DUUMINI_COMMISSION_RATE).toFixed(2);
}

/* =========================
 * ✅ Receipt helpers (token + number)
 * =======================*/
function genReceiptToken() {
  return crypto.randomBytes(32).toString("hex");
}

function formatReceiptNumber(orderId, createdAt = null) {
  // DM-YYYY-000123
  const dt = createdAt ? new Date(createdAt) : new Date();
  const year = dt.getFullYear();
  const seq = String(Number(orderId || 0)).padStart(6, "0");
  return `DM-${year}-${seq}`;
}

async function detectOrdersReceiptCols(conn) {
  const candidates = ["receipt_number", "receipt_token"];
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates,
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return {
    receipt_number: found.has("receipt_number"),
    receipt_token: found.has("receipt_token"),
  };
}

/* =========================
 * ✅ vérifier si une commande ne contient QUE les produits d'un vendeur
 * =======================*/
async function vendorOwnsWholeOrder(conn, orderId, vendorId) {
  const [[r]] = await conn.query(
    `
    SELECT
      SUM(CASE WHEN s.owner_id = ? THEN 1 ELSE 0 END) AS mine_count,
      COUNT(*) AS total_count,
      COUNT(DISTINCT s.owner_id) AS vendors_count
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN shops s    ON s.id = p.shop_id
    WHERE oi.order_id = ?
    `,
    [vendorId, orderId],
  );

  const mine = Number(r?.mine_count || 0);
  const total = Number(r?.total_count || 0);
  const vendorsCount = Number(r?.vendors_count || 0);

  if (!total) return false;
  return mine === total && vendorsCount === 1;
}

async function getOrderWithPerm(conn, id, user) {
  const [[orderRaw]] = await conn.query(`SELECT * FROM orders WHERE id=?`, [
    id,
  ]);
  if (!orderRaw) return { status: 404, error: "Not found" };

  if (!isAdmin(user)) {
    if (isVendor(user)) {
      const [[own]] = await conn.query(
        `
        SELECT 1
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        JOIN shops s    ON s.id = p.shop_id
        WHERE oi.order_id = ? AND s.owner_id = ?
        LIMIT 1
        `,
        [id, user.id],
      );
      if (!own) return { status: 403, error: "Forbidden" };
    } else {
      if (String(orderRaw.user_id) !== String(user.id))
        return { status: 403, error: "Forbidden" };
    }
  }

  const order = stripCommissionFromOrderRow(orderRaw, user);

  let itemsSql = `
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
  `;

  const params = [];
  if (isVendor(user) && !isAdmin(user)) {
    itemsSql += `
      LEFT JOIN shops s ON s.id = p.shop_id
      WHERE oi.order_id = ? AND s.owner_id = ?
    `;
    params.push(id, user.id);
  } else {
    itemsSql += ` WHERE oi.order_id = ? `;
    params.push(id);
  }

  itemsSql += ` ORDER BY oi.id ASC `;

  const [items] = await conn.query(itemsSql, params);
  return { status: 200, order, items };
}

/* ========= Notifications ========= */
async function getAdminUserIds() {
  const [rows] = await getPool().query(
    `SELECT id 
       FROM users 
      WHERE role = 'ADMIN'
        AND (is_active = 1 OR is_active IS NULL)`,
  );
  return (rows || []).map((r) => r.id);
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
    [orderId],
  );
  return (rows || []).map((r) => r.user_id);
}

async function enqueueOrderCreatedNotifications(orderId, total, currency) {
  const [adminIds, vendorIds] = await Promise.all([
    getAdminUserIds(),
    getVendorsForOrder(orderId),
  ]);
  const allUserIds = Array.from(
    new Set([...(adminIds || []), ...(vendorIds || [])]),
  );
  if (!allUserIds.length) return;

  const cur = (currency || "MAD").toUpperCase();
  const displayCode = buildDisplayCode(orderId);
  const totalNum = Number(total || 0);

  const payloadObj = {
    title: `Nouvelle commande ${displayCode}`,
    body: `Un client vient de passer une commande ${displayCode} de ${totalNum} ${cur}.`,
    order_id: orderId,
    display_code: displayCode,
    total: totalNum,
    currency: cur,
    status: "OPEN",
  };

  const payload = JSON.stringify(payloadObj);
  const values = allUserIds.map((uid) => [
    uid,
    "ORDER_CREATED",
    payload,
    "queued",
  ]);

  await getPool().query(
    `
    INSERT INTO notification_queue (user_id, type, payload, status)
    VALUES ?
    `,
    [values],
  );
}

async function emitOrderCreatedRealtimeWSOnly(orderId, total, currency) {
  let notifyUser;
  try {
    ({ notifyUser } = require("../services/notify"));
  } catch {
    return;
  }

  const [adminIds, vendorIds] = await Promise.all([
    getAdminUserIds(),
    getVendorsForOrder(orderId),
  ]);
  const userIds = Array.from(
    new Set([...(adminIds || []), ...(vendorIds || [])]),
  );
  if (!userIds.length) return;

  const cur = (currency || "MAD").toUpperCase();
  const displayCode = buildDisplayCode(orderId);
  const totalNum = Number(total || 0);

  const payloadObj = {
    title: `Nouvelle commande ${displayCode}`,
    body: `Un client vient de passer une commande ${displayCode} de ${totalNum} ${cur}.`,
    order_id: orderId,
    display_code: displayCode,
    total: totalNum,
    currency: cur,
    status: "OPEN",
  };

  await Promise.all(
    userIds.map((uid) =>
      notifyUser(uid, "ORDER_CREATED", payloadObj, { push: false }),
    ),
  );
}

async function enqueueOrderStatusForClient(orderId, status) {
  const [[row]] = await getPool().query(
    `SELECT user_id, total, currency
       FROM orders
      WHERE id = ?
      LIMIT 1`,
    [orderId],
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
    [row.user_id, JSON.stringify(payloadObj)],
  );
}

/* =========================
 * WhatsApp admin
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
  const hasFrom = !!(
    env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_FROM
  );
  if (!hasFrom) return;
  if (!ADMIN_WHATSAPP || !String(ADMIN_WHATSAPP).trim().startsWith("whatsapp:"))
    return;

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
      [orderId],
    );

    if (rows && rows.length) {
      details = rows
        .map((r) => {
          const label = r.product_name || "Produit";
          const vtxt = [r.v_size, r.v_color].filter(Boolean).join(" / ");
          const suffix = vtxt ? ` (${vtxt})` : "";
          const qty = Number(r.qty || 1);
          const price = Number(r.unit_price || 0);
          return `• ${label}${suffix} ×${qty} — ${price} ${(currency || "MAD").toUpperCase()}`;
        })
        .join("\n");
    }
  } catch {
    if (Array.isArray(items) && items.length) {
      details = items
        .map((it) => {
          const label = it?.name || `Produit #${it?.product_id || ""}`.trim();
          const qty = it?.qty || 1;
          const price =
            it?.price != null
              ? `${it.price} ${(currency || "MAD").toUpperCase()}`
              : "";
          return `• ${label} ×${qty}${price ? ` — ${price}` : ""}`;
        })
        .join("\n");
    }
  }

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
      [orderId],
    );
    if (rowImg && rowImg.url) firstProductImage = rowImg.url;
  } catch {}

  const fullName =
    `${contactObj?.first_name || ""} ${contactObj?.last_name || ""}`.trim() ||
    "Client Duumini";

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
  } catch {}
}

/* =========================
 * STOCK helpers
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

/* =========================
 * PROMO helpers
 * =======================*/
function normalizePromoType(value) {
  const t = String(value || "")
    .trim()
    .toUpperCase();
  if (t === "AMOUNT") return "AMOUNT";
  if (t === "PERCENT") return "PERCENT";
  return "PERCENT";
}

function computePromoPrice(basePrice, promoEligible, type, value) {
  const base = Number(basePrice || 0);
  if (!promoEligible) return null;

  const v = Number(value);
  if (!Number.isFinite(base) || base <= 0) return null;
  if (!Number.isFinite(v) || v <= 0) return null;

  const t = String(type || "").toUpperCase();
  let out = base;

  if (t === "AMOUNT") out = base - v;
  else if (t === "PERCENT") out = base * (1 - v / 100);
  else out = base * (1 - v / 100);

  if (!Number.isFinite(out)) return null;
  if (out < 0) out = 0;
  return +out.toFixed(2);
}

function calcLineUnitPriceWithPromo({ baseUnitPrice, p }) {
  const base = Number(baseUnitPrice || 0);
  if (!Number.isFinite(base) || base < 0) {
    return {
      base_unit_price: 0,
      unit_price: 0,
      promo_applied: 0,
      promo_type: null,
      promo_value: null,
    };
  }

  const eligible = Number(p?.promo_eligible || 0) === 1;
  const promoValue = Number(p?.promo_discount_value);
  const hasValue = Number.isFinite(promoValue) && promoValue > 0;
  const promoType = normalizePromoType(p?.promo_discount_type || "PERCENT");

  if (!eligible || !hasValue) {
    return {
      base_unit_price: +base.toFixed(2),
      unit_price: +base.toFixed(2),
      promo_applied: 0,
      promo_type: null,
      promo_value: null,
    };
  }

  const promoPrice = computePromoPrice(base, true, promoType, promoValue);
  if (promoPrice == null) {
    return {
      base_unit_price: +base.toFixed(2),
      unit_price: +base.toFixed(2),
      promo_applied: 0,
      promo_type: null,
      promo_value: null,
    };
  }

  return {
    base_unit_price: +base.toFixed(2),
    unit_price: promoPrice,
    promo_applied: 1,
    promo_type: promoType,
    promo_value: promoValue,
  };
}

/* =========================
 * OPTIONAL: détecter colonnes promo dans order_items
 * =======================*/
let _orderItemsPromoCols = null;
let _orderItemsPromoColsLoaded = false;

async function detectOrderItemsPromoCols(conn) {
  const candidates = [
    "promo_applied",
    "promo_type",
    "promo_value",
    "base_unit_price",
  ];
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'order_items'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates,
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return {
    promo_applied: found.has("promo_applied"),
    promo_type: found.has("promo_type"),
    promo_value: found.has("promo_value"),
    base_unit_price: found.has("base_unit_price"),
  };
}

async function getOrderItemsPromoColsCached(pool) {
  if (_orderItemsPromoColsLoaded) return _orderItemsPromoCols;
  const conn = await pool.getConnection();
  try {
    _orderItemsPromoCols = await detectOrderItemsPromoCols(conn);
    _orderItemsPromoColsLoaded = true;
    return _orderItemsPromoCols;
  } finally {
    conn.release();
  }
}

/* =========================
 * ✅ Payment columns detection + normalization
 * =======================*/
let _ordersPayCols = null;
let _ordersPayColsLoaded = false;

async function detectOrdersPayCols(conn) {
  const candidates = [
    "payment",
    "payment_status",
    "paid_amount",
    "remaining_amount",
  ];
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})`,
    candidates,
  );
  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));
  return {
    payment: found.has("payment"),
    payment_status: found.has("payment_status"),
    paid_amount: found.has("paid_amount"),
    remaining_amount: found.has("remaining_amount"),
  };
}

async function getOrdersPayColsCached(pool) {
  if (_ordersPayColsLoaded) return _ordersPayCols;
  const conn = await pool.getConnection();
  try {
    _ordersPayCols = await detectOrdersPayCols(conn);
    _ordersPayColsLoaded = true;
    return _ordersPayCols;
  } finally {
    conn.release();
  }
}

function normMoney(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return 0;
  return +n.toFixed(2);
}

function normPayStatus(s) {
  const v = String(s || "")
    .trim()
    .toUpperCase();
  if (v === "PAID" || v === "UNPAID" || v === "PARTIAL" || v === "PENDING")
    return v;
  return null;
}

function isBankTransferMethod(m) {
  const v = String(m || "")
    .trim()
    .toUpperCase();
  return (
    v === "BANK_TRANSFER" ||
    v === "BANK" ||
    v === "TRANSFER" ||
    v === "VIREMENT"
  );
}

function buildPaymentFromPayload(payment, orderTotal, currency) {
  const cur = String(currency || "MAD").toUpperCase();
  const p = payment && typeof payment === "object" ? payment : {};
  const askedStatus = normPayStatus(p.status);
  const total = normMoney(orderTotal);

  const method = String(p.method || "CASH").toUpperCase();
  const isBank = isBankTransferMethod(method);

  const paid = Math.min(
    normMoney(p.paid_amount ?? p.paidAmount ?? p.amount ?? 0),
    total,
  );
  const remaining = Math.max(0, total - paid);

  let status = askedStatus || "UNPAID";

  if (paid >= total && total > 0) status = "PAID";
  else if (total <= 0) status = "PAID";
  else if (isBank) status = "PENDING";
  else if (paid <= 0) status = "UNPAID";
  else status = "PARTIAL";

  return {
    status,
    paid_amount: paid,
    remaining_amount: remaining,
    currency: cur,
    method,
    note: p.note ? String(p.note).slice(0, 500) : null,
  };
}

function normalizePaymentForRow(row, orderTotal, currency, payCols) {
  const total = normMoney(orderTotal);
  const cur = String(currency || "MAD").toUpperCase();

  const paymentParsed = safeParseJSON(row?.payment) || null;

  const colStatus = payCols?.payment_status
    ? normPayStatus(row?.payment_status)
    : null;
  const colPaid = payCols?.paid_amount ? normMoney(row?.paid_amount) : null;
  const colRemain = payCols?.remaining_amount
    ? normMoney(row?.remaining_amount)
    : null;

  const jsonPaid = paymentParsed
    ? normMoney(paymentParsed.paid_amount ?? paymentParsed.paidAmount ?? 0)
    : 0;
  const paid = colPaid != null ? colPaid : jsonPaid;

  const remaining =
    colRemain != null ? colRemain : Math.max(0, total - Math.min(paid, total));

  let status = colStatus;
  if (!status) {
    if (paid <= 0) status = "UNPAID";
    else if (paid >= total || total <= 0) status = "PAID";
    else status = "PARTIAL";
  }

  const parsedMethod = paymentParsed?.method ?? null;
  const isBank = isBankTransferMethod(parsedMethod);

  if (isBank && status !== "PAID" && total > 0) status = "PENDING";

  const paymentObj = paymentParsed
    ? {
        ...paymentParsed,
        status,
        paid_amount: Math.min(paid, total),
        remaining_amount: remaining,
        currency: String(paymentParsed.currency || cur).toUpperCase(),
      }
    : {
        status,
        paid_amount: Math.min(paid, total),
        remaining_amount: remaining,
        currency: cur,
        method: null,
        note: null,
      };

  return {
    payment: paymentObj,
    payment_status: status,
    paid_amount: paymentObj.paid_amount,
    remaining_amount: paymentObj.remaining_amount,
  };
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
      p.promo_discount_type,
      p.promo_discount_value
    FROM products p
    WHERE p.id=? FOR UPDATE
    `,
    [productId],
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
    [variantId, productId],
  );
  return v || null;
}

/* =========================
 * ✅ Multi-status filter
 * =======================*/
const ORDER_STATUSES = ["OPEN", "PREPARATION", "DELIVERY", "DONE", "CANCELLED"];

function parseStatusesQuery(req) {
  const rawCsv = req.query.statuses ?? req.query.status_list ?? null;
  const rawArray = req.query["status[]"] ?? req.query.statusArray ?? null;
  const rawSingle = req.query.status ?? null;

  let list = [];

  if (rawCsv) {
    list = String(rawCsv)
      .split(",")
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
  } else if (Array.isArray(rawArray)) {
    list = rawArray.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  } else if (rawArray != null) {
    list = String(rawArray)
      .split(",")
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
  } else if (rawSingle) {
    const s = String(rawSingle).trim().toUpperCase();
    if (s && s !== "ALL") list = [s];
  }

  list = Array.from(new Set(list)).filter((s) => ORDER_STATUSES.includes(s));
  return list;
}

function buildStatusWhere(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0)
    return { sql: "", params: [] };
  if (statuses.length === 1)
    return { sql: " AND o.status = ?", params: [statuses[0]] };
  return {
    sql: ` AND o.status IN (${statuses.map(() => "?").join(",")})`,
    params: [...statuses],
  };
}

/* =========================
 * LIST
 * =======================*/
router.get("/", authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  const mine = req.query.mine === "1" || req.query.mine === "true";
  const statuses = parseStatusesQuery(req);

  const payFilterRaw =
    req.query.payment_status ??
    req.query.paymentStatus ??
    req.query.pay ??
    req.query.payStatus ??
    null;

  const payFilter = normPayStatus(payFilterRaw);

  try {
    const payCols = await getOrdersPayColsCached(pool);

    if (payFilter && !(payCols && payCols.payment_status)) {
      return res.status(400).json({
        code: "PAYMENT_FILTER_UNAVAILABLE",
        message:
          "Le filtre payment_status est demandé mais la colonne orders.payment_status n'existe pas encore. Ajoute la migration puis réessaie.",
      });
    }

    const mapRowToItem = (r, user, payCols) => {
      const address = safeParseJSON(r.address);
      const contactFromOrder = safeParseJSON(r.contact);
      const contact =
        contactFromOrder &&
        (contactFromOrder.first_name ||
          contactFromOrder.last_name ||
          contactFromOrder.phone)
          ? contactFromOrder
          : buildContactFromUser({
              first_name: r.u_first,
              last_name: r.u_last,
              phone: r.u_phone,
            });

      const geo_link = r.geo_link || buildGeoLink(address?.gps);
      const isVendorView = isVendor(user) && !isAdmin(user);

      const itemsAmount = Number(r.items_amount || 0);
      const currency = (r.currency || "MAD").toUpperCase();

      const totalAmount = isVendorView
        ? itemsAmount
        : Number(r.total || itemsAmount);
      const deliveryFee = isVendorView
        ? 0
        : Math.max(0, totalAmount - itemsAmount);

      const paymentNorm = normalizePaymentForRow(
        r,
        Number(r.total || itemsAmount),
        currency,
        payCols,
      );

      // ✅ CA Duumini (commission) = 9% des produits
      const duuminiCommission = isCancelledStatus(r.status)
        ? 0
        : computeDuuminiCommission(itemsAmount);

      // ✅ si la DB a déjà commission_duumini, on garde la valeur (mais on peut l’écraser si besoin)
      // ici on privilégie le calcul pour cohérence 9%
      const commissionDuumini = isVendorView
        ? null
        : isCancelledStatus(r.status)
          ? 0
          : duuminiCommission;

      return {
        ...r,
        commission_duumini: commissionDuumini,
        display_code: buildDisplayCode(r.id),
        address,
        contact,
        geo_link,
        ...paymentNorm,
        totals: {
          items_amount: +itemsAmount.toFixed(2),
          delivery_fee: +deliveryFee.toFixed(2),
          amount: +totalAmount.toFixed(2),
          currency,
          duumini_commission: commissionDuumini, // ✅ CA Duumini (9%)
        },
      };
    };

    // mine => client
    if (mine) {
      const params = [req.user.id];
      let where = "o.user_id = ?";

      const st = buildStatusWhere(statuses);
      where += st.sql;
      params.push(...st.params);

      if (payFilter) {
        where += " AND o.payment_status = ?";
        params.push(payFilter);
      }

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM orders o WHERE ${where}`,
        params,
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
        [...params, limit, offset],
      );

      const rows = rowsRaw.map((r) => stripCommissionFromOrderRow(r, req.user));
      const items = rows.map((r) => mapRowToItem(r, req.user, payCols));
      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    // admin => tout
    if (isAdmin(req.user)) {
      let where = "1=1";
      const params = [];

      const st = buildStatusWhere(statuses);
      where += st.sql;
      params.push(...st.params);

      if (payFilter) {
        where += " AND o.payment_status = ?";
        params.push(payFilter);
      }

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) total FROM orders o WHERE ${where}`,
        params,
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
        [...params, limit, offset],
      );

      const items = rowsRaw.map((r) => mapRowToItem(r, req.user, payCols));
      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    // vendor => commandes contenant ses produits
    if (isVendor(req.user)) {
      let where = "s.owner_id = ?";
      const params = [req.user.id];

      const st = buildStatusWhere(statuses);
      where += st.sql;
      params.push(...st.params);

      if (payFilter) {
        where += " AND o.payment_status = ?";
        params.push(payFilter);
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
        params,
      );

      const [rowsRaw] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
          (
            SELECT SUM(oi_mine.qty * oi_mine.unit_price)
            FROM order_items oi_mine
            JOIN products p_mine ON p_mine.id = oi_mine.product_id
            JOIN shops s_mine    ON s_mine.id = p_mine.shop_id
            WHERE oi_mine.order_id = o.id
              AND s_mine.owner_id = ?
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
        [req.user.id, req.user.id, ...params, limit, offset],
      );

      const items = rowsRaw.map((r) => mapRowToItem(r, req.user, payCols));
      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    // fallback client normal
    const params = [req.user.id];
    let where = "o.user_id = ?";

    const st = buildStatusWhere(statuses);
    where += st.sql;
    params.push(...st.params);

    if (payFilter) {
      where += " AND o.payment_status = ?";
      params.push(payFilter);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM orders o WHERE ${where}`,
      params,
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
      [...params, limit, offset],
    );

    const rows = rowsRaw.map((r) => stripCommissionFromOrderRow(r, req.user));
    const items = rows.map((r) => mapRowToItem(r, req.user, payCols));
    return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Shared: build cleanItems with promo
 * ✅ Commission Duumini = 9% itemsAmount (pas besoin par ligne)
 * =======================*/
async function buildCleanItemsWithPromo({ conn, items }) {
  let itemsAmount = 0;
  const cleanItems = [];

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

    let base_unit_price = Number(p.price || 0);
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

      base_unit_price =
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

    const promoPack = calcLineUnitPriceWithPromo({
      baseUnitPrice: base_unit_price,
      p,
    });
    const unit_price = promoPack.unit_price;

    cleanItems.push({
      product_id: p.id,
      qty,
      unit_price,
      base_unit_price: promoPack.base_unit_price,
      promo_applied: promoPack.promo_applied,
      promo_type: promoPack.promo_type,
      promo_value: promoPack.promo_value,
      stockSource,
      current_stock,
      variant_id: variant_id || null,
      variant_meta,
    });

    itemsAmount += unit_price * qty;
  }

  // ✅ commission globale
  const totalCommission = computeDuuminiCommission(itemsAmount);

  return { cleanItems, itemsAmount, totalCommission };
}

/* =========================
 * Encaissement / update payment (ADMIN ONLY)
 * PUT /api/orders/:id/payment
 * =======================*/
router.put("/:id/payment", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: "invalid id" });
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const pool = getPool();

  try {
    const payCols = await getOrdersPayColsCached(pool);
    const hasAny =
      payCols?.payment ||
      payCols?.payment_status ||
      payCols?.paid_amount ||
      payCols?.remaining_amount;

    if (!hasAny) {
      return res.status(409).json({
        code: "PAYMENT_COLUMNS_MISSING",
        message:
          "Impossible de mettre à jour le paiement: colonnes payment/payment_status/paid_amount/remaining_amount absentes. Ajoute la migration puis réessaie.",
      });
    }

    const mode = String(req.body?.mode || "ADD")
      .trim()
      .toUpperCase();
    if (mode !== "SET" && mode !== "ADD")
      return res.status(400).json({ error: "invalid mode (SET|ADD)" });

    const add_amount = req.body?.add_amount ?? req.body?.addAmount ?? null;
    const paid_amount =
      req.body?.paid_amount ?? req.body?.paidAmount ?? req.body?.amount ?? null;

    const method = req.body?.method
      ? String(req.body.method).toUpperCase()
      : null;
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;

    if (mode === "ADD") {
      const v = Number(add_amount);
      if (!Number.isFinite(v) || v <= 0)
        return res.status(400).json({ error: "add_amount required" });
    } else {
      const v = Number(paid_amount);
      if (!Number.isFinite(v) || v < 0)
        return res.status(400).json({ error: "paid_amount required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[o]] = await conn.query(
        `
        SELECT id, status, total, currency, payment, paid_amount
        FROM orders
        WHERE id = ?
        FOR UPDATE
        `,
        [id],
      );

      if (!o) {
        await conn.rollback();
        return res.status(404).json({ error: "Not found" });
      }

      const total = Number(o.total || 0);
      const currency = (o.currency || "MAD").toUpperCase();

      const currentPayment = safeParseJSON(o.payment) || {};
      const currentPaid = Number.isFinite(Number(o.paid_amount))
        ? Number(o.paid_amount)
        : Number(currentPayment.paid_amount || 0) || 0;

      let nextPaid = currentPaid;
      if (mode === "ADD") nextPaid = currentPaid + Number(add_amount || 0);
      else nextPaid = Number(paid_amount || 0);

      if (!Number.isFinite(nextPaid) || nextPaid < 0) nextPaid = 0;
      if (Number.isFinite(total) && total >= 0)
        nextPaid = Math.min(nextPaid, total);

      const merged = {
        ...currentPayment,
        ...(method ? { method } : {}),
        ...(note ? { note } : {}),
        paid_amount: nextPaid,
      };

      const paymentObj = buildPaymentFromPayload(merged, total, currency);

      const sets = [];
      const vals = [];

      if (payCols.payment) {
        sets.push("payment = ?");
        vals.push(JSON.stringify(paymentObj));
      }
      if (payCols.payment_status) {
        sets.push("payment_status = ?");
        vals.push(paymentObj.status);
      }
      if (payCols.paid_amount) {
        sets.push("paid_amount = ?");
        vals.push(paymentObj.paid_amount);
      }
      if (payCols.remaining_amount) {
        sets.push("remaining_amount = ?");
        vals.push(paymentObj.remaining_amount);
      }

      sets.push("updated_at = NOW()");
      await conn.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, [
        ...vals,
        id,
      ]);

      await conn.commit();

      return res.json({
        ok: true,
        id,
        status: String(o.status || "").toUpperCase(),
        display_code: buildDisplayCode(id),
        payment: paymentObj,
      });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      return res.status(500).json({ error: e.message });
    } finally {
      conn.release();
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * Create order (auth)
 * =======================*/
router.post("/", authRequired, async (req, res) => {
  const {
    contact = null,
    address = {},
    delivery = {},
    items = [],
    totals = {},
    payment = null,
  } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items[] required" });

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    let contactObj = contact ? buildContactFromPayload(contact) : null;
    if (
      !contactObj ||
      (!contactObj.first_name && !contactObj.last_name && !contactObj.phone)
    ) {
      contactObj = buildContactFromUser(req.user);
    }

    const promoCols = await getOrderItemsPromoColsCached(pool);

    const { cleanItems, itemsAmount, totalCommission } =
      await buildCleanItemsWithPromo({ conn, items });

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (
      delivery?.currency ||
      totals?.currency ||
      "MAD"
    ).toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    const payCols = await getOrdersPayColsCached(pool);
    const paymentObj = buildPaymentFromPayload(payment, orderTotal, currency);

    // ✅ Receipt fields
    const receiptCols = await detectOrdersReceiptCols(conn);
    const receiptToken = receiptCols.receipt_token ? genReceiptToken() : null;

    const cols = [
      "user_id",
      "status",
      "address",
      "contact",
      "geo_link",
      "total",
      "commission_duumini",
      "currency",
      "created_at",
      "updated_at",
    ];
    const placeholders = [
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "NOW()",
      "NOW()",
    ];
    const vals = [
      req.user.id,
      "OPEN",
      JSON.stringify(addressObj),
      JSON.stringify(contactObj),
      geoLink,
      +orderTotal.toFixed(2),
      +totalCommission.toFixed(2), // ✅ 9% produits
      currency,
    ];

    if (receiptCols.receipt_number) {
      cols.push("receipt_number");
      placeholders.push("?");
      vals.push(null); // on le mettra après avoir l'orderId
    }
    if (receiptCols.receipt_token) {
      cols.push("receipt_token");
      placeholders.push("?");
      vals.push(receiptToken);
    }

    if (payCols?.payment) {
      cols.push("payment");
      placeholders.push("?");
      vals.push(JSON.stringify(paymentObj));
    }
    if (payCols?.payment_status) {
      cols.push("payment_status");
      placeholders.push("?");
      vals.push(paymentObj.status);
    }
    if (payCols?.paid_amount) {
      cols.push("paid_amount");
      placeholders.push("?");
      vals.push(paymentObj.paid_amount);
    }
    if (payCols?.remaining_amount) {
      cols.push("remaining_amount");
      placeholders.push("?");
      vals.push(paymentObj.remaining_amount);
    }

    const [r] = await conn.query(
      `INSERT INTO orders (${cols.join(",")}) VALUES (${placeholders.join(",")})`,
      vals,
    );
    const orderId = r.insertId;
    const displayCode = buildDisplayCode(orderId);

    // ✅ finalize receipt_number (pro)
    if (receiptCols.receipt_number) {
      const receiptNumber = formatReceiptNumber(orderId, new Date());
      // collision improbable mais on reste safe
      await conn.query(`UPDATE orders SET receipt_number = ? WHERE id = ?`, [
        receiptNumber,
        orderId,
      ]);
    }

    for (const it of cleanItems) {
      if (
        promoCols &&
        (promoCols.promo_applied ||
          promoCols.promo_type ||
          promoCols.promo_value ||
          promoCols.base_unit_price)
      ) {
        const cols2 = [
          "order_id",
          "product_id",
          "variant_id",
          "qty",
          "unit_price",
        ];
        const vals2 = [
          orderId,
          it.product_id,
          it.variant_id,
          it.qty,
          it.unit_price,
        ];

        if (promoCols.base_unit_price) {
          cols2.push("base_unit_price");
          vals2.push(it.base_unit_price);
        }
        if (promoCols.promo_applied) {
          cols2.push("promo_applied");
          vals2.push(it.promo_applied || 0);
        }
        if (promoCols.promo_type) {
          cols2.push("promo_type");
          vals2.push(it.promo_type || null);
        }
        if (promoCols.promo_value) {
          cols2.push("promo_value");
          vals2.push(it.promo_value != null ? Number(it.promo_value) : null);
        }

        await conn.query(
          `INSERT INTO order_items (${cols2.join(",")}) VALUES (${cols2.map(() => "?").join(",")})`,
          vals2,
        );
      } else {
        await conn.query(
          `INSERT INTO order_items (order_id, product_id, variant_id, qty, unit_price) VALUES (?,?,?,?,?)`,
          [orderId, it.product_id, it.variant_id, it.qty, it.unit_price],
        );
      }
    }

    // stock decrement
    for (const it of cleanItems) {
      if (it.current_stock === null || it.current_stock === undefined) continue;

      const currentStock = Number(it.current_stock || 0);
      const newStock = currentStock - Number(it.qty || 0);

      if (newStock < 0) {
        const err = new Error("STOCK_INSUFFICIENT");
        err.statusCode = 400;
        err.payload = {
          code: "STOCK_INSUFFICIENT",
          message:
            "La quantité demandée n'est plus disponible pour un des produits de votre panier.",
          product_id: it.product_id,
          variant_id: it.variant_id || null,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      if (it.stockSource === "VARIANT" && it.variant_id) {
        await conn.query(`UPDATE product_variants SET stock=? WHERE id=?`, [
          newStock,
          it.variant_id,
        ]);
      } else {
        await conn.query(`UPDATE products SET stock=? WHERE id=?`, [
          newStock,
          it.product_id,
        ]);
      }
    }

    await conn.commit();

    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch {}
    try {
      const { notifyUser } = require("../services/notify");
      await notifyUser(req.user.id, "ORDER_CREATED", {
        title: `Commande ${displayCode} créée`,
        body: `Votre commande ${displayCode} a été créée. Total: ${Number(orderTotal || 0)} ${currency}.`,
        order_id: orderId,
        display_code: displayCode,
        total: Number(orderTotal || 0),
        currency,
        status: "OPEN",
      });
    } catch {}
    try {
      await emitOrderCreatedRealtimeWSOnly(orderId, orderTotal, currency);
    } catch {}

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
      total: +orderTotal.toFixed(2),
      currency,
      geo_link: geoLink || null,
      payment: paymentObj || null,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    if (e && e.statusCode === 400 && e.payload)
      return res.status(400).json(e.payload);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Create order guest
 * =======================*/
router.post("/guest", async (req, res) => {
  const {
    contact = {},
    address = {},
    delivery = {},
    items = [],
    totals = {},
    payment = null,
  } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items[] required" });

  const contactObj = buildContactFromPayload(contact);
  if (!contactObj.phone) {
    return res.status(400).json({
      code: "PHONE_REQUIRED",
      message:
        "Un numéro de téléphone est obligatoire pour passer une commande.",
    });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    const promoCols = await getOrderItemsPromoColsCached(pool);

    const { cleanItems, itemsAmount, totalCommission } =
      await buildCleanItemsWithPromo({ conn, items });

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (
      delivery?.currency ||
      totals?.currency ||
      "MAD"
    ).toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    const payCols = await getOrdersPayColsCached(pool);
    const paymentObj = buildPaymentFromPayload(payment, orderTotal, currency);

    const receiptCols = await detectOrdersReceiptCols(conn);
    const receiptToken = receiptCols.receipt_token ? genReceiptToken() : null;

    const cols = [
      "user_id",
      "status",
      "address",
      "contact",
      "geo_link",
      "total",
      "commission_duumini",
      "currency",
      "created_at",
      "updated_at",
    ];
    const placeholders = [
      "NULL",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "?",
      "NOW()",
      "NOW()",
    ];
    const vals = [
      "OPEN",
      JSON.stringify(addressObj),
      JSON.stringify(contactObj),
      geoLink,
      +orderTotal.toFixed(2),
      +totalCommission.toFixed(2),
      currency,
    ];

    if (receiptCols.receipt_number) {
      cols.push("receipt_number");
      placeholders.push("?");
      vals.push(null);
    }
    if (receiptCols.receipt_token) {
      cols.push("receipt_token");
      placeholders.push("?");
      vals.push(receiptToken);
    }

    if (payCols?.payment) {
      cols.push("payment");
      placeholders.push("?");
      vals.push(JSON.stringify(paymentObj));
    }
    if (payCols?.payment_status) {
      cols.push("payment_status");
      placeholders.push("?");
      vals.push(paymentObj.status);
    }
    if (payCols?.paid_amount) {
      cols.push("paid_amount");
      placeholders.push("?");
      vals.push(paymentObj.paid_amount);
    }
    if (payCols?.remaining_amount) {
      cols.push("remaining_amount");
      placeholders.push("?");
      vals.push(paymentObj.remaining_amount);
    }

    const [r] = await conn.query(
      `INSERT INTO orders (${cols.join(",")}) VALUES (${placeholders.join(",")})`,
      vals,
    );
    const orderId = r.insertId;
    const displayCode = buildDisplayCode(orderId);

    if (receiptCols.receipt_number) {
      const receiptNumber = formatReceiptNumber(orderId, new Date());
      await conn.query(`UPDATE orders SET receipt_number = ? WHERE id = ?`, [
        receiptNumber,
        orderId,
      ]);
    }

    for (const it of cleanItems) {
      if (
        promoCols &&
        (promoCols.promo_applied ||
          promoCols.promo_type ||
          promoCols.promo_value ||
          promoCols.base_unit_price)
      ) {
        const cols2 = [
          "order_id",
          "product_id",
          "variant_id",
          "qty",
          "unit_price",
        ];
        const vals2 = [
          orderId,
          it.product_id,
          it.variant_id,
          it.qty,
          it.unit_price,
        ];

        if (promoCols.base_unit_price) {
          cols2.push("base_unit_price");
          vals2.push(it.base_unit_price);
        }
        if (promoCols.promo_applied) {
          cols2.push("promo_applied");
          vals2.push(it.promo_applied || 0);
        }
        if (promoCols.promo_type) {
          cols2.push("promo_type");
          vals2.push(it.promo_type || null);
        }
        if (promoCols.promo_value) {
          cols2.push("promo_value");
          vals2.push(it.promo_value != null ? Number(it.promo_value) : null);
        }

        await conn.query(
          `INSERT INTO order_items (${cols2.join(",")}) VALUES (${cols2.map(() => "?").join(",")})`,
          vals2,
        );
      } else {
        await conn.query(
          `INSERT INTO order_items (order_id, product_id, variant_id, qty, unit_price) VALUES (?,?,?,?,?)`,
          [orderId, it.product_id, it.variant_id, it.qty, it.unit_price],
        );
      }
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
          message:
            "La quantité demandée n'est plus disponible pour un des produits de votre panier.",
          product_id: it.product_id,
          variant_id: it.variant_id || null,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      if (it.stockSource === "VARIANT" && it.variant_id) {
        await conn.query(`UPDATE product_variants SET stock=? WHERE id=?`, [
          newStock,
          it.variant_id,
        ]);
      } else {
        await conn.query(`UPDATE products SET stock=? WHERE id=?`, [
          newStock,
          it.product_id,
        ]);
      }
    }

    await conn.commit();

    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch {}
    try {
      await emitOrderCreatedRealtimeWSOnly(orderId, orderTotal, currency);
    } catch {}

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
      total: +orderTotal.toFixed(2),
      currency,
      geo_link: geoLink || null,
      payment: paymentObj || null,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    if (e && e.statusCode === 400 && e.payload)
      return res.status(400).json(e.payload);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Get one order
 * =======================*/
router.get("/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const conn = await getPool().getConnection();

  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200)
      return res.status(result.status).json({ error: result.error });

    const o = result.order;
    const addr = safeParseJSON(o.address);

    const [[u]] = await conn.query(
      "SELECT first_name, last_name, phone FROM users WHERE id=? LIMIT 1",
      [o.user_id],
    );

    const contactFromOrder = safeParseJSON(o.contact);
    const contact =
      contactFromOrder &&
      (contactFromOrder.first_name ||
        contactFromOrder.last_name ||
        contactFromOrder.phone)
        ? contactFromOrder
        : buildContactFromUser(u);

    const itemsAmount = result.items.reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.qty || 1),
      0,
    );

    const isVendorView = isVendor(req.user) && !isAdmin(req.user);
    const totalAmount = isVendorView
      ? itemsAmount
      : Number(o.total || itemsAmount);
    const deliveryFee = isVendorView
      ? 0
      : Math.max(0, totalAmount - itemsAmount);
    const currency = (o.currency || "MAD").toUpperCase();

    const payCols = await getOrdersPayColsCached(getPool());
    const paymentNorm = normalizePaymentForRow(
      o,
      Number(o.total || itemsAmount),
      currency,
      payCols,
    );

    const duuminiCommission = isCancelledStatus(o.status)
      ? 0
      : computeDuuminiCommission(itemsAmount);

    res.json({
      ...o,
      commission_duumini: isVendorView ? null : duuminiCommission,
      display_code: buildDisplayCode(o.id),
      contact,
      address: addr,
      ...paymentNorm,
      items: result.items,
      totals: {
        items_amount: +itemsAmount.toFixed(2),
        delivery_fee: +deliveryFee.toFixed(2),
        amount: +totalAmount.toFixed(2),
        currency,
        duumini_commission: isVendorView ? null : duuminiCommission,
      },
      geo_link: o.geo_link || buildGeoLink(addr?.gps) || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * ✅ RECEIPT PDF (with QR)
 * GET /api/orders/:id/receipt.pdf
 * =======================*/
// ✅ PUBLIC: get receipt JSON by token (no auth)
// GET /api/orders/receipt/:token
router.get("/receipt/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "invalid token" });

  const conn = await getPool().getConnection();
  try {
    const [[o]] = await conn.query(
      `SELECT * FROM orders WHERE receipt_token = ? LIMIT 1`,
      [token],
    );
    if (!o) return res.status(404).json({ error: "Not found" });

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
      [o.id],
    );

    const addr = safeParseJSON(o.address) || {};
    const contact = safeParseJSON(o.contact) || {};

    const itemsAmount = (items || []).reduce(
      (s, it) => s + Number(it.unit_price || 0) * Number(it.qty || 1),
      0,
    );

    const currency = (o.currency || "MAD").toUpperCase();
    const totalAmount = Number(o.total || itemsAmount);
    const deliveryFee = Math.max(0, totalAmount - itemsAmount);

    res.json({
      ...o,
      display_code: buildDisplayCode(o.id),
      address: addr,
      contact,
      items,
      totals: {
        items_amount: +itemsAmount.toFixed(2),
        delivery_fee: +deliveryFee.toFixed(2),
        amount: +totalAmount.toFixed(2),
        currency,
      },
      geo_link: o.geo_link || buildGeoLink(addr?.gps) || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ✅ PUBLIC: receipt PDF by token (no auth)
// GET /api/orders/receipt/:token/receipt.pdf
router.get("/receipt/:token/receipt.pdf", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "invalid token" });

  const conn = await getPool().getConnection();
  try {
    const [[o]] = await conn.query(
      `SELECT * FROM orders WHERE receipt_token = ? LIMIT 1`,
      [token],
    );
    if (!o) return res.status(404).json({ error: "Not found" });

    // ✅ Réutilise exactement ton code PDF, mais basé sur o.id
    // Le plus simple: appelle la même logique que /:id/receipt.pdf (copie/colle)
    // ici je te laisse le principe: récup items, calc totals, generate PDF.
    // (si tu veux je te colle le bloc complet PDF token-ready)
    return res.status(501).json({ error: "TODO: implement token pdf" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});
router.get("/:id/receipt.pdf", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: "invalid id" });

  const conn = await getPool().getConnection();
  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200)
      return res.status(result.status).json({ error: result.error });

    const o = result.order;
    const items = result.items || [];
    const currency = (o.currency || "MAD").toUpperCase();

    const address = safeParseJSON(o.address) || {};
    const contact = safeParseJSON(o.contact) || {};

    const itemsAmount = items.reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.qty || 1),
      0,
    );
    const totalAmount = Number(o.total || itemsAmount);
    const deliveryFee = Math.max(0, totalAmount - itemsAmount);

    // ✅ CA Duumini séparé
    const duuminiCommission = isCancelledStatus(o.status)
      ? 0
      : computeDuuminiCommission(itemsAmount);

    // QR payload -> vérification (token si dispo)
    const token = o.receipt_token ? String(o.receipt_token) : null;
    const base = (
      env.PUBLIC_WEB_BASE ||
      process.env.PUBLIC_WEB_BASE ||
      "https://duumini.com"
    ).replace(/\/+$/, "");
    const verifyUrl = token ? `${base}/r/${token}` : `${base}/orders/${id}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      margin: 1,
      scale: 6,
    });

    // PDF
    res.setHeader("Content-Type", "application/pdf");
    const filename = `${o.receipt_number || `receipt-${id}`}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Header
    doc.fontSize(22).text("DUUMINI", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(10).text("Reçu de commande", { align: "left" });
    doc.moveDown();

    const receiptNo =
      o.receipt_number ||
      `DM-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
    const displayCode = buildDisplayCode(id);

    doc.fontSize(12).text(`Reçu N° : ${receiptNo}`);
    doc.text(`Commande : ${displayCode}`);
    doc.text(`Statut : ${(o.status || "").toUpperCase()}`);
    doc.text(
      `Date : ${o.created_at ? new Date(o.created_at).toLocaleString("fr-FR") : new Date().toLocaleString("fr-FR")}`,
    );
    doc.moveDown();

    // Client & Livraison
    const fullName =
      `${contact.first_name || ""} ${contact.last_name || ""}`.trim() ||
      "Client";
    doc.fontSize(12).text("Client", { underline: true });
    doc.fontSize(10).text(`Nom : ${fullName}`);
    if (contact.phone) doc.text(`Téléphone : ${contact.phone}`);
    doc.moveDown(0.5);

    doc.fontSize(12).text("Adresse", { underline: true });
    doc.fontSize(10).text(`Ville : ${address.city || "—"}`);
    doc.text(`Commune : ${address.commune || "—"}`);
    doc.text(`Quartier : ${address.district || "—"}`);
    doc.moveDown();

    // Items
    doc.fontSize(12).text("Détails", { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10);
    items.forEach((it) => {
      const name = it.product_name || `Produit #${it.product_id || ""}`;
      const qty = Number(it.qty || 1);
      const unit = Number(it.unit_price || 0);
      const line = +(qty * unit).toFixed(2);
      const variant = [it.variant_size, it.variant_color]
        .filter(Boolean)
        .join(" / ");
      const suffix = variant ? ` (${variant})` : "";
      doc.text(
        `• ${name}${suffix}  x${qty}  —  ${unit.toFixed(2)} ${currency}  =  ${line.toFixed(2)} ${currency}`,
      );
    });

    doc.moveDown();

    // Totals (séparés)
    doc.fontSize(12).text("Totaux", { underline: true });
    doc.fontSize(10);
    doc.text(`Sous-total produits : ${itemsAmount.toFixed(2)} ${currency}`);
    doc.text(`Frais de livraison : ${deliveryFee.toFixed(2)} ${currency}`);
    doc.moveDown(0.3);
    doc.fontSize(12).text(`TOTAL : ${totalAmount.toFixed(2)} ${currency}`);
    doc.moveDown(0.6);

    doc
      .fontSize(10)
      .text(
        `CA Duumini (9% sur produits) : ${duuminiCommission.toFixed(2)} ${currency}`,
      );
    doc.moveDown();

    // QR
    const qrBase64 = qrDataUrl.split(",")[1];
    const qrBuf = Buffer.from(qrBase64, "base64");
    doc.fontSize(10).text("Scanner pour vérifier le reçu :", { align: "left" });
    doc.image(qrBuf, doc.x, doc.y + 6, { width: 110 });
    doc.moveDown(6);
    doc.fontSize(8).text(`Lien : ${verifyUrl}`);

    doc.end();
  } catch (e) {
    try {
      res.status(500).json({ error: e.message });
    } catch {}
  } finally {
    conn.release();
  }
});
// ✅ SEND RECEIPT VIA WHATSAPP (ADMIN)
// POST /api/orders/:id/send-receipt-whatsapp
router.post("/:id/send-receipt-whatsapp", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: "invalid id" });
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const conn = await getPool().getConnection();
  try {
    const [[o]] = await conn.query(
      `SELECT id, receipt_token, receipt_number, contact, total, currency
         FROM orders
        WHERE id = ?
        LIMIT 1`,
      [id],
    );
    if (!o) return res.status(404).json({ error: "Not found" });

    const contact = safeParseJSON(o.contact) || {};
    const phone = normPhone(contact.phone);
    if (!phone) {
      return res.status(409).json({
        code: "PHONE_MISSING",
        message: "Le client n'a pas de numéro sur la commande.",
      });
    }

    if (!o.receipt_token) {
      return res.status(409).json({
        code: "RECEIPT_TOKEN_MISSING",
        message:
          "receipt_token absent. Ajoute/active la colonne receipt_token et assure-toi qu'elle est remplie à la création.",
      });
    }

    // ✅ base publique pour Twilio (doit être accessible sans auth)
    const apiBase = String(
      env.PUBLIC_API_BASE || process.env.PUBLIC_API_BASE || "",
    ).replace(/\/+$/, "");
    if (!apiBase) {
      return res.status(409).json({
        code: "PUBLIC_API_BASE_MISSING",
        message:
          "Définis PUBLIC_API_BASE (ex: https://duumini-api.onrender.com) pour générer un lien public du PDF.",
      });
    }

    const pdfUrl = `${apiBase}/api/orders/receipt/${o.receipt_token}.pdf`; // ✅ route publique par token
    const receiptNumber =
      o.receipt_number ||
      `DM-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
    const displayCode = buildDisplayCode(id);

    await sendWhatsAppReceiptToClient({
      to: phone,
      receiptNumber,
      displayCode,
      total: Number(o.total || 0),
      currency: (o.currency || "MAD").toUpperCase(),
      pdfUrl,
    });

    return res.json({ ok: true, to: phone, pdfUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
  if (!allowed.includes(status))
    return res.status(400).json({ error: "invalid status" });

  const pool = getPool();

  try {
    if (!isAdmin(req.user)) {
      if (!isVendor(req.user))
        return res.status(403).json({ error: "Forbidden" });

      const conn = await pool.getConnection();
      try {
        const ok = await vendorOwnsWholeOrder(conn, id, req.user.id);
        if (!ok)
          return res
            .status(403)
            .json({ error: "Forbidden (multi-vendor order)" });
      } finally {
        conn.release();
      }
    }

    await pool.query(
      `UPDATE orders SET status=?, updated_at=NOW() WHERE id=?`,
      [status, id],
    );

    const [[order]] = await pool.query(
      `SELECT user_id FROM orders WHERE id=?`,
      [id],
    );
    if (order && order.user_id) {
      const displayCode = buildDisplayCode(id);

      try {
        await enqueueOrderStatusForClient(id, status);
      } catch {}
      try {
        const { notifyUser } = require("../services/notify");
        await notifyUser(order.user_id, "ORDER_STATUS", {
          title: `Commande ${displayCode} mise à jour`,
          body: `Le statut de votre commande ${displayCode} est passé à ${status}.`,
          order_id: id,
          display_code: displayCode,
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
 * Cancel (restock)
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

    if (!isAdmin(req.user) && isVendor(req.user)) {
      const ok = await vendorOwnsWholeOrder(conn, id, req.user.id);
      if (!ok) {
        await conn.rollback();
        return res
          .status(403)
          .json({ error: "Forbidden (multi-vendor order)" });
      }
    }

    const order = result.order;
    const blocked = ["DONE", "CANCELLED"].includes(order.status || "");
    if (blocked && !isAdmin(req.user)) {
      await conn.rollback();
      return res.status(409).json({ error: "Cannot cancel at this stage" });
    }

    const [items] = await conn.query(
      `SELECT product_id, variant_id, qty FROM order_items WHERE order_id=? ORDER BY id ASC`,
      [id],
    );

    for (const it of items) {
      const qty = Number(it.qty || 0);
      if (!qty) continue;

      if (it.variant_id) {
        await conn.query(
          `UPDATE product_variants SET stock = COALESCE(stock,0) + ? WHERE id=?`,
          [qty, it.variant_id],
        );
      } else if (it.product_id) {
        await conn.query(
          `UPDATE products SET stock = COALESCE(stock,0) + ? WHERE id=?`,
          [qty, it.product_id],
        );
      }
    }

    await conn.query(
      `UPDATE orders
      SET status='CANCELLED',
          commission_duumini = 0,
          updated_at=NOW()
    WHERE id=?`,
      [id],
    );

    await conn.commit();

    try {
      if (order.user_id) {
        const displayCode = buildDisplayCode(id);

        await enqueueOrderStatusForClient(id, "CANCELLED");

        const { notifyUser } = require("../services/notify");
        await notifyUser(order.user_id, "ORDER_STATUS", {
          title: `Commande ${displayCode} annulée`,
          body: `Votre commande ${displayCode} a été annulée.`,
          order_id: id,
          display_code: displayCode,
          status: "CANCELLED",
        });
      }
    } catch {}

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
