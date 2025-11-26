// src/routes/orders.js
const { Router } = require('express');
const { getPool } = require('../lib/db');
const { authRequired, requireRole, isAdmin, isVendor } = require('../middlewares/auth');
const { getPagination, buildPageInfo } = require('../utils/pagination');
const { sendWhatsAppOrderConfirmation } = require('../services/twilio');
const { env } = require('../lib/env');

const router = Router();

/* =========================
 * CONFIG WHATSAPP BACKOFFICE
 * =======================*/

// 👉 Seul ce numéro reçoit la commande par WhatsApp
const BACKOFFICE_WHATSAPP =
  env.DUUMINI_BACKOFFICE_WHATSAPP || '+212623677884';

/* =========================
 * Helpers
 * =======================*/

/** Parse JSON sans throw */
function safeParseJSON(maybe) {
  if (!maybe) return null;
  if (typeof maybe === 'object') return maybe;
  try { return JSON.parse(maybe); } catch { return null; }
}

/** Normalise l'objet adresse reçu du front en un objet stockable (JSON).
 * input: { ville, commune, quartier|null, gps:{lat,lng}|null }
 * ou éventuellement juste { gps:{lat,lng} }
 */
function buildAddressObj(input = {}) {
  const ville = input?.ville ?? null;
  const commune = input?.commune ?? null;
  const quartier = input?.quartier ?? null;
  const gps = input?.gps && typeof input.gps === 'object'
    ? { lat: Number(input.gps.lat), lng: Number(input.gps.lng) }
    : null;

  return {
    city: ville,
    commune,
    district: quartier,
    gps,
  };
}

/** Construit un lien Google Maps à partir d'un gps {lat,lng} */
function buildGeoLink(gps) {
  if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') return null;
  return `https://maps.google.com/?q=${gps.lat},${gps.lng}`;
}

/** Normalisation téléphone (+212...) */
function normPhone(p) {
  const raw = String(p || '').replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+' + raw.slice(2);
  if (/^0\d{9,}$/.test(raw)) return '+212' + raw.slice(1);
  return raw;
}

/** Construit un objet contact à partir d'un user row */
function buildContactFromUser(u) {
  if (!u) return { first_name: null, last_name: null, phone: null };
  return {
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    phone: normPhone(u.phone) || null,
  };
}

/** Construit un contact à partir du payload front
 *  - accepte { first_name, last_name, phone }
 *  - accepte aussi { name, phone } pour les invités (nom complet)
 */
function buildContactFromPayload(c = {}) {
  const rawFirst = c?.first_name ?? null;
  const rawLast = c?.last_name ?? null;
  const rawName = c?.name ?? null;

  let first_name = rawFirst;
  let last_name = rawLast;

  // si on a "name" (invité) mais pas de first/last, on découpe grossièrement
  if (!first_name && !last_name && rawName) {
    const parts = String(rawName).trim().split(/\s+/);
    if (parts.length === 1) {
      first_name = parts[0];
      last_name = null;
    } else {
      first_name = parts[0];
      last_name = parts.slice(1).join(' ');
    }
  }

  const phone = normPhone(c?.phone);
  return {
    first_name: first_name || null,
    last_name: last_name || null,
    phone: phone || null,
  };
}

/** Construit un code d'affichage alphanumérique à partir de l'id */
function buildDisplayCode(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    return String(id ?? '').toUpperCase();
  }
  return n.toString(36).toUpperCase(); // ex: 123 => "3F"
}

/**
 * Commission pour une ligne : 18% food, 11% sinon.
 * ⚠️ Ici on passe le PRIX VENDEUR (base) pour calculer la commission Duumini.
 *    Ex: base = 750 → commission = 750 * taux, JAMAIS déduite de 750.
 */
function computeCommissionForLine(baseUnitPrice, qty, subCategory) {
  const totalBaseLine = Number(baseUnitPrice || 0) * Number(qty || 1);
  const sub = String(subCategory || '').trim().toLowerCase();
  const rate = sub === 'food' ? 0.18 : 0.11;
  return +(totalBaseLine * rate).toFixed(2);
}

/**
 * Prix unitaire payé par le client = prix vendeur + commission
 * → utilisé pour order_items.unit_price
 *    Ex: base = 750, rate=0.11 → client_unit = 750 * 1.11 = 832.5
 */
function computeClientUnitPrice(basePrice, subCategory) {
  const sub = String(subCategory || '').trim().toLowerCase();
  const rate = sub === 'food' ? 0.18 : 0.11;
  const base = Number(basePrice || 0);
  return +(base * (1 + rate)).toFixed(2);
}

/** On enlève commission_duumini pour les clients (non admin / non vendeur) */
function stripCommissionFromOrderRow(row, user) {
  if (!row) return row;
  if (isAdmin(user) || isVendor(user)) return row;
  const { commission_duumini, ...rest } = row;
  return rest;
}

/**
 * Charge une commande + vérifie les permissions en fonction de req.user.
 * Règles:
 * - ADMIN: accès total
 * - VENDEUR: doit être propriétaire d'au moins un shop lié à la commande
 * - CLIENT: doit être l'acheteur (orders.user_id)
 * Retour:
 *   { status: 200, order, items }  ou  { status, error }
 */
async function getOrderWithPerm(conn, id, user) {
  const [[orderRaw]] = await conn.query(`SELECT * FROM orders WHERE id=?`, [id]);
  if (!orderRaw) return { status: 404, error: 'Not found' };

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
        [id, user.id]
      );
      if (!own) return { status: 403, error: 'Forbidden' };
    } else {
      if (String(orderRaw.user_id) !== String(user.id)) {
        return { status: 403, error: 'Forbidden' };
      }
    }
  }

  // On masque la commission pour les clients simples
  const order = stripCommissionFromOrderRow(orderRaw, user);

  // ✅ Items + nom produit + image (product_cover)
  const [items] = await conn.query(
    `
    SELECT 
      oi.*,
      p.name AS product_name,
      (
        SELECT pi.url
        FROM product_images pi
        WHERE pi.product_id = oi.product_id
        ORDER BY pi.sort_order ASC, pi.id ASC
        LIMIT 1
      ) AS product_cover
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
    ORDER BY oi.id ASC
    `,
    [id]
  );

  return { status: 200, order, items };
}

/* ========= Helpers notifications commande ========= */

/**
 * Récupère la liste des user_id admins actifs
 */
async function getAdminUserIds() {
  const [rows] = await getPool().query(
    `SELECT id 
       FROM users 
      WHERE role = 'ADMIN'
        AND (is_active = 1 OR is_active IS NULL)`
  );
  return rows.map((r) => r.id);
}

/**
 * Récupère la liste des vendeurs concernés par une commande donnée.
 * On remonte depuis order_items -> products -> shops (owner_id).
 */
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

/**
 * Enfile des notifications ORDER_CREATED pour vendeurs + admins
 * dans notification_queue.
 */
async function enqueueOrderCreatedNotifications(orderId, total, currency) {
  const [adminIds, vendorIds] = await Promise.all([
    getAdminUserIds(),
    getVendorsForOrder(orderId),
  ]);

  const allUserIds = Array.from(new Set([...adminIds, ...vendorIds]));
  if (!allUserIds.length) return;

  const cur = (currency || 'MAD').toUpperCase();
  const displayCode = buildDisplayCode(orderId);

  const payloadObj = {
    title: `Nouvelle commande ${displayCode}`,
    body: `Un client vient de passer une commande ${displayCode} de ${total} ${cur}.`,
    order_id: orderId,
    display_code: displayCode,
    total,
    currency: cur,
    status: 'OPEN',
  };

  const payload = JSON.stringify(payloadObj);

  const values = allUserIds.map((uid) => [
    uid,
    'ORDER_CREATED',
    payload,
    'queued',
  ]);

  await getPool().query(
    `
    INSERT INTO notification_queue (user_id, type, payload, status)
    VALUES ?
    `,
    [values]
  );
}

/**
 * Enfile une notification ORDER_STATUS pour le client (si user_id non NULL)
 */
async function enqueueOrderStatusForClient(orderId, status) {
  const [[row]] = await getPool().query(
    `SELECT user_id, total, currency
       FROM orders
      WHERE id = ?
      LIMIT 1`,
    [orderId]
  );

  if (!row || !row.user_id) return; // commande invité sans compte → pas de notif user_id

  const cur = (row.currency || 'MAD').toUpperCase();
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
 * List (admin : tout / client : ses commandes)
 * → ajoute toujours un champ contact (fallback users)
 * → ajoute first_product_cover pour la miniature
 * → ajoute items_amount (somme des lignes produits → CA hors livraison côté client)
 * → ajoute geo_link + display_code
 * =======================*/
router.get('/', authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  // 🔍 options de filtrage
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const rawStatus = req.query.status
    ? String(req.query.status).toUpperCase()
    : null;
  const hasStatus = rawStatus && rawStatus !== 'ALL';

  try {
    /* =========================
     * CAS 1 : ?mine=1 → TOUJOURS MES COMMANDES
     * =======================*/
    if (mine) {
      const params = [req.user.id];
      let where = 'o.user_id = ?';

      if (hasStatus) {
        where += ' AND o.status = ?';
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

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || 'MAD').toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,  // 🔥 sous-total client hors livraison
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    /* =========================
     * CAS 2 : ADMIN (backoffice)
     * =======================*/
    if (isAdmin(req.user)) {
      let where = '1=1';
      const params = [];

      if (hasStatus) {
        where += ' AND o.status = ?';
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
            -- 💰 CA hors livraison = sous-total produits (PRIX CLIENT)
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

      // Admin peut voir la commission → pas de strip
      const rows = rowsRaw;

      const items = rows.map((r) => {
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

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || 'MAD').toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,  // CA client hors livraison
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    /* =========================
     * CAS 3 : VENDEUR (backoffice vendeur)
     * =======================*/
    if (isVendor(req.user)) {
      let where = 's.owner_id = ?';
      const params = [req.user.id];

      if (hasStatus) {
        where += ' AND o.status = ?';
        params.push(rawStatus);
      }

      // Nombre de commandes qui contiennent au moins 1 produit de ce vendeur
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
            -- CA hors livraison (côté client, toute la commande)
            SELECT SUM(oi_all.qty * oi_all.unit_price)
            FROM order_items oi_all
            WHERE oi_all.order_id = o.id
          ) AS items_amount,
          (
            -- image d'un produit de CE vendeur (pour la carte)
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

      // Vendeur peut voir la commission → pas de strip
      const rows = rowsRaw;

      const items = rows.map((r) => {
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

        const itemsAmount = Number(r.items_amount || 0);
        const totalAmount = Number(r.total || itemsAmount);
        const deliveryFee = Math.max(0, totalAmount - itemsAmount);
        const currency = (r.currency || 'MAD').toUpperCase();

        return {
          ...r,
          display_code: buildDisplayCode(r.id),
          address,
          contact,
          geo_link,
          totals: {
            items_amount: itemsAmount,  // CA client hors livraison
            delivery_fee: deliveryFee,
            amount: totalAmount,
            currency,
          },
        };
      });

      return res.json({
        items,
        pageInfo: buildPageInfo(total, page, pageSize),
      });
    }

    /* =========================
     * CAS 4 : CLIENT simple (non admin / non vendeur)
     * =======================*/
    const params = [req.user.id];
    let where = 'o.user_id = ?';

    if (hasStatus) {
      where += ' AND o.status = ?';
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

      const itemsAmount = Number(r.items_amount || 0);
      const totalAmount = Number(r.total || itemsAmount);
      const deliveryFee = Math.max(0, totalAmount - itemsAmount);
      const currency = (r.currency || 'MAD').toUpperCase();

      return {
        ...r,
        display_code: buildDisplayCode(r.id),
        address,
        contact,
        geo_link,
        totals: {
          items_amount: itemsAmount,   // CA client hors livraison
          delivery_fee: deliveryFee,
          amount: totalAmount,
          currency,
        },
      };
    });

    return res.json({
      items,
      pageInfo: buildPageInfo(total, page, pageSize),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* =========================
 * Create order (UTILISATEUR CONNECTÉ)
 * =======================*/
router.post('/', authRequired, async (req, res) => {
  const {
    contact = null,
    address = {},
    delivery = {},
    items = [],
    totals = {},
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) Normaliser adresse et geo_link
    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    // 2) Contact snapshot: payload > user
    let contactObj = contact ? buildContactFromPayload(contact) : null;
    if (!contactObj || (!contactObj.first_name && !contactObj.last_name && !contactObj.phone)) {
      contactObj = buildContactFromUser(req.user);
    }

    // 3) Recalcule total articles côté serveur (ignore price du front)
    let itemsAmount = 0;
    let totalCommission = 0;
    const cleanItems = [];

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = Number(it?.qty);
      if (!product_id || !qty) {
        const err = new Error('product_id & qty required');
        err.statusCode = 400;
        throw err;
      }

      // 🔒 On verrouille la ligne produit + on récupère le stock
      const [[p]] = await conn.query(
        `SELECT id, price, sub_category, stock FROM products WHERE id=? FOR UPDATE`,
        [product_id]
      );
      if (!p) {
        const err = new Error('Product not found: ' + product_id);
        err.statusCode = 400;
        throw err;
      }

      const basePrice = Number(p.price); // 💰 PRIX VENDEUR (ex: 750)
      const unit_price = computeClientUnitPrice(basePrice, p.sub_category); // 💸 PRIX CLIENT (base + commission)
      const lineCommission = computeCommissionForLine(basePrice, qty, p.sub_category); // 🧾 commission Duumini sur base

      cleanItems.push({
        product_id: p.id,
        qty,
        unit_price,          // ✅ ce que paie le client
        current_stock: p.stock,
      });

      itemsAmount += unit_price * qty;   // ✅ total client (hors livraison)
      totalCommission += lineCommission; // ✅ somme des commissions (sur prix vendeur)
    }

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || 'MAD').toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    // 4) INSERT order
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

    // 5) INSERT order_items (snapshots des prix client)
    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    // 6) Décrémenter le stock pour chaque produit
    for (const it of cleanItems) {
      // Stock NULL ou undefined → stock illimité → on ne touche pas
      if (it.current_stock === null || it.current_stock === undefined) {
        continue;
      }

      const currentStock = Number(it.current_stock || 0);
      const newStock = currentStock - Number(it.qty || 0);

      if (newStock < 0) {
        const err = new Error('STOCK_INSUFFICIENT');
        err.statusCode = 400;
        err.payload = {
          code: 'STOCK_INSUFFICIENT',
          product_id: it.product_id,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      await conn.query(
        `UPDATE products SET stock=? WHERE id=?`,
        [newStock, it.product_id]
      );
    }

    await conn.commit();

    // 🔔 7) Enfiler des notifications pour vendeurs + admins
    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error('[Notify] enqueueOrderCreatedNotifications failed', eNot);
    }

    // 8) Notification temps réel pour le client
    try {
      const { notifyUser } = require('../services/notify');
      await notifyUser(req.user.id, 'ORDER_CREATED', {
        order_id: orderId,
        display_code: displayCode,
        total: orderTotal,
      });
    } catch {}

    // 9) Envoi WhatsApp au BACKOFFICE UNIQUEMENT (pas au client)
    (async () => {
      try {
        const fullName = `${contactObj.first_name || ''} ${contactObj.last_name || ''}`.trim() || 'Client Duumini';

        const details = Array.isArray(items) && items.length
          ? items
              .map((it) => {
                const label = it.name || `Produit #${it.product_id || ''}`.trim();
                const qty = it.qty || 1;
                const price = it.price != null ? `${it.price} MAD` : '';
                return `• ${label} ×${qty}${price ? ` — ${price}` : ''}`;
              })
              .join('\n')
          : '';

        // 🔎 Récupérer la première image produit de cette commande
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
          if (rowImg && rowImg.url) {
            firstProductImage = rowImg.url;
          }
        } catch (imgErr) {
          console.error(`[WhatsApp] Erreur chargement image produit commande #${orderId}`, imgErr);
        }

        await sendWhatsAppOrderConfirmation({
          to: BACKOFFICE_WHATSAPP,
          name: fullName,
          orderId,
          displayCode,
          total: orderTotal,
          ville: addressObj.city || null,
          commune: addressObj.commune || null,
          quartier: addressObj.district || null,
          phone: contactObj.phone,
          details,
          imageUrl: firstProductImage || null,
        });

        console.log(
          `[WhatsApp] Commande #${orderId} (user connecté) envoyée au backoffice ${BACKOFFICE_WHATSAPP}`
        );
      } catch (errWa) {
        console.error(
          `[WhatsApp] Erreur envoi commande #${orderId} au backoffice`,
          errWa
        );
      }
    })();

    res.status(201).json({
      id: orderId,
      display_code: displayCode,
      status: 'OPEN',
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    if (e && e.statusCode === 400 && e.payload?.code === 'STOCK_INSUFFICIENT') {
      return res.status(400).json(e.payload);
    }
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/* =========================
 * Create order invité (SANS AUTH)
 * =======================*/
router.post('/guest', async (req, res) => {
  const {
    contact = {},
    address = {},
    delivery = {},
    items = [],
    totals = {},
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required' });
  }

  // 👇 Invité : on veut au minimum un téléphone + un nom si possible
  const contactObj = buildContactFromPayload(contact);
  if (!contactObj.phone) {
    return res.status(400).json({ error: 'phone required' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) Normaliser adresse et geo_link
    const addressObj = buildAddressObj(address);
    const geoLink = buildGeoLink(addressObj.gps);

    // 2) Recalcule total articles côté serveur
    let itemsAmount = 0;
    let totalCommission = 0;
    const cleanItems = [];

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = Number(it?.qty);
      if (!product_id || !qty) {
        const err = new Error('product_id & qty required');
        err.statusCode = 400;
        throw err;
      }

      // 🔒 On verrouille la ligne produit + on récupère le stock
      const [[p]] = await conn.query(
        `SELECT id, price, sub_category, stock FROM products WHERE id=? FOR UPDATE`,
        [product_id]
      );
      if (!p) {
        const err = new Error('Product not found: ' + product_id);
        err.statusCode = 400;
        throw err;
      }

      const basePrice = Number(p.price); // prix vendeur
      const unit_price = computeClientUnitPrice(basePrice, p.sub_category); // prix client
      const lineCommission = computeCommissionForLine(basePrice, qty, p.sub_category);

      cleanItems.push({
        product_id: p.id,
        qty,
        unit_price,
        current_stock: p.stock,
      });

      itemsAmount += unit_price * qty;
      totalCommission += lineCommission;
    }

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || 'MAD').toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    // 3) INSERT order invité
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

    // 4) INSERT order_items
    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    // 5) Décrémenter le stock pour chaque produit
    for (const it of cleanItems) {
      if (it.current_stock === null || it.current_stock === undefined) {
        continue;
      }

      const currentStock = Number(it.current_stock || 0);
      const newStock = currentStock - Number(it.qty || 0);

      if (newStock < 0) {
        const err = new Error('STOCK_INSUFFICIENT');
        err.statusCode = 400;
        err.payload = {
          code: 'STOCK_INSUFFICIENT',
          product_id: it.product_id,
          requested: Number(it.qty || 0),
          available: currentStock,
        };
        throw err;
      }

      await conn.query(
        `UPDATE products SET stock=? WHERE id=?`,
        [newStock, it.product_id]
      );
    }

    await conn.commit();

    // 🔔 6) Enfiler des notifications pour vendeurs + admins
    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error('[Notify] enqueueOrderCreatedNotifications failed (guest)', eNot);
    }

    // 7) Envoi WhatsApp au BACKOFFICE UNIQUEMENT (pas au client)
    (async () => {
      try {
        const fullName = `${contactObj.first_name || ''} ${contactObj.last_name || ''}`.trim()
          || 'Client invité Duumini';

        const details = Array.isArray(items) && items.length
          ? items
              .map((it) => {
                const label = it.name || `Produit #${it.product_id || ''}`.trim();
                const qty = it.qty || 1;
                const price = it.price != null ? `${it.price} MAD` : '';
                return `• ${label} ×${qty}${price ? ` — ${price}` : ''}`;
              })
              .join('\n')
          : '';

        // 🔎 Récupérer la première image produit de cette commande
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
          if (rowImg && rowImg.url) {
            firstProductImage = rowImg.url;
          }
        } catch (imgErr) {
          console.error(`[WhatsApp] Erreur chargement image produit commande invité #${orderId}`, imgErr);
        }

        await sendWhatsAppOrderConfirmation({
          to: BACKOFFICE_WHATSAPP,
          name: fullName,
          orderId,
          displayCode,
          total: orderTotal,
          ville: addressObj.city || null,
          commune: addressObj.commune || null,
          quartier: addressObj.district || null,
          phone: contactObj.phone,
          details,
          imageUrl: firstProductImage || null,
        });

        console.log(
          `[WhatsApp] Commande invité #${orderId} envoyée au backoffice ${BACKOFFICE_WHATSAPP}`
        );
      } catch (errWa) {
        console.error(
          `[WhatsApp] Erreur envoi commande invité #${orderId} au backoffice`,
          errWa
        );
      }
    })();

    res.status(201).json({
      id: orderId,
      display_code: displayCode,
      status: 'OPEN',
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    if (e && e.statusCode === 400 && e.payload?.code === 'STOCK_INSUFFICIENT') {
      return res.status(400).json(e.payload);
    }
    res.status(500).json({ error: e.message });  
  } finally {
    conn.release();
  }
});

/* =========================
 * Get one order (detail + items) avec permissions
 * =======================*/
router.get('/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    const o = result.order;
    const addr = safeParseJSON(o.address);

    // Charger user pour fallback contact
    const [[u]] = await conn.query(
      'SELECT first_name, last_name, phone FROM users WHERE id=? LIMIT 1',
      [o.user_id]
    );
    const contactFromOrder = safeParseJSON(o.contact);
    const contact =
      (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
        ? contactFromOrder
        : buildContactFromUser(u);

    // ✅ Totaux pour le front (CA client hors livraison)
    const itemsAmount = result.items.reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.qty || 1),
      0
    );
    const totalAmount = Number(o.total || itemsAmount);
    const deliveryFee = Math.max(0, totalAmount - itemsAmount);
    const currency = (o.currency || 'MAD').toUpperCase();

    res.json({
      ...o,
      display_code: buildDisplayCode(o.id),
      contact,               
      address: addr,
      items: result.items,   // contient product_cover
      totals: {
        items_amount: itemsAmount,
        delivery_fee: deliveryFee,
        amount: totalAmount,
        currency,
      },
      geo_link: o.geo_link || buildGeoLink(addr?.gps) || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

/* =========================
 * Update status
 * =======================*/
router.put('/:id/status', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ['OPEN','PREPARATION','DELIVERY','DONE','CANCELLED'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

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

      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!(isVendor(req.user) && String(row.owner_id) === String(req.user.id))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(`UPDATE orders SET status=?, updated_at=NOW() WHERE id=?`, [status, id]);

    const [[order]] = await pool.query(`SELECT user_id FROM orders WHERE id=?`, [id]);
    if (order && order.user_id) {
      // 🔔 file d'attente pour push + WS temps réel
      try {
        await enqueueOrderStatusForClient(id, status);
      } catch (eQueue) {
        console.error('[Notify] enqueueOrderStatusForClient failed', eQueue);
      }

      try {
        const { notifyUser } = require('../services/notify');
        await notifyUser(order.user_id, 'ORDER_STATUS', {
          order_id: id,
          display_code: buildDisplayCode(id),
          status,
        });
      } catch {}
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
 * Annulation par l’acheteur (ou admin)
 * =======================*/
router.post('/:id/cancel', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const result = await getOrderWithPerm(conn, id, req.user);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    const order = result.order;
    const blocked = ['DONE', 'CANCELLED'].includes(order.status || '');
    if (blocked && !isAdmin(req.user)) {
      return res.status(409).json({ error: 'Cannot cancel at this stage' });
    }

    await conn.query(`UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE id=?`, [id]);

    try {
      if (order.user_id) {
        await enqueueOrderStatusForClient(id, 'CANCELLED');

        const { notifyUser } = require('../services/notify');
        await notifyUser(order.user_id, 'ORDER_STATUS', {
          order_id: id,
          display_code: buildDisplayCode(id),
          status: 'CANCELLED',
        });
      }
    } catch (eNot) {
      console.error('[Notify] ORDER_STATUS cancel failed', eNot);
    }

    res.json({ ok: true, status: 'CANCELLED' });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
