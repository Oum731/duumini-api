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
  const [[order]] = await conn.query(`SELECT * FROM orders WHERE id=?`, [id]);
  if (!order) return { status: 404, error: 'Not found' };

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
      if (String(order.user_id) !== String(user.id)) {
        return { status: 403, error: 'Forbidden' };
      }
    }
  }

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

  const payloadObj = {
    title: `Nouvelle commande #${orderId}`,
    body: `Un client vient de passer une commande de ${total} ${cur}.`,
    order_id: orderId,
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

  const payloadObj = {
    title: `Mise à jour commande #${orderId}`,
    body: `Le statut de votre commande est passé à ${status}.`,
    order_id: orderId,
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
 * → ajoute geo_link pour ouvrir la localisation (connecté + invité)
 * =======================*/
router.get('/', authRequired, async (req, res) => {
  const { page, pageSize, offset, limit } = getPagination(req);
  const pool = getPool();

  try {
    // ===== ADMIN =====
    if (isAdmin(req.user)) {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM orders`);
      const [rows] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
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
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [limit, offset]
      );

      const items = rows.map(r => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        const geo_link = r.geo_link || buildGeoLink(address?.gps);

        return {
          ...r,
          address,
          contact,
          geo_link,
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }

    // ===== VENDEUR =====
    if (isVendor(req.user)) {
      // Nombre de commandes qui contiennent au moins 1 produit de ce vendeur
      const [[{ total }]] = await pool.query(
        `
        SELECT COUNT(DISTINCT o.id) AS total
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p     ON p.id = oi.product_id
        JOIN shops s        ON s.id = p.shop_id
        WHERE s.owner_id = ?
        `,
        [req.user.id]
      );

      const [rows] = await pool.query(
        `
        SELECT 
          o.*,
          u.first_name AS u_first,
          u.last_name  AS u_last,
          u.phone      AS u_phone,
          (
            SELECT pi.url
            FROM order_items oi2
            JOIN products p2     ON p2.id = oi2.product_id
            JOIN shops s2        ON s2.id = p2.shop_id
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
        WHERE s.owner_id = ?
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [req.user.id, req.user.id, limit, offset]
      );

      const items = rows.map(r => {
        const address = safeParseJSON(r.address);
        const contactFromOrder = safeParseJSON(r.contact);
        const contact =
          (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
            ? contactFromOrder
            : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

        const geo_link = r.geo_link || buildGeoLink(address?.gps);

        return {
          ...r,
          address,
          contact,
          geo_link,
        };
      });

      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    }

    // ===== CLIENT SIMPLE (historique de ses commandes) =====
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM orders WHERE user_id=?`,
      [req.user.id]
    );
    const [rows] = await pool.query(
      `
      SELECT 
        o.*,
        u.first_name AS u_first,
        u.last_name  AS u_last,
        u.phone      AS u_phone,
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
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [req.user.id, limit, offset]
    );

    const items = rows.map(r => {
      const address = safeParseJSON(r.address);
      const contactFromOrder = safeParseJSON(r.contact);
      const contact =
        (contactFromOrder && (contactFromOrder.first_name || contactFromOrder.last_name || contactFromOrder.phone))
          ? contactFromOrder
          : buildContactFromUser({ first_name: r.u_first, last_name: r.u_last, phone: r.u_phone });

      const geo_link = r.geo_link || buildGeoLink(address?.gps);

      return {
        ...r,
        address,
        contact,
        geo_link,
      };
    });

    return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
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
    const cleanItems = [];

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = Number(it?.qty);
      if (!product_id || !qty) throw new Error('product_id & qty required');

      const [[p]] = await conn.query(
        `SELECT id, price FROM products WHERE id=?`,
        [product_id]
      );
      if (!p) throw new Error('Product not found: ' + product_id);

      const unit_price = Number(p.price);
      cleanItems.push({ product_id: p.id, qty, unit_price });
      itemsAmount += unit_price * qty;
    }

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || 'MAD').toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    // 4) INSERT order
    const [r] = await conn.query(
      `
      INSERT INTO orders (user_id, status, address, contact, geo_link, total, currency, created_at, updated_at)
      VALUES (?, 'OPEN', ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        req.user.id,
        JSON.stringify(addressObj),
        JSON.stringify(contactObj),
        geoLink,
        orderTotal,
        currency,
      ]
    );
    const orderId = r.insertId;

    // 5) INSERT order_items (snapshots des prix)
    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    await conn.commit();

    // 🔔 6) Enfiler des notifications pour vendeurs + admins
    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error('[Notify] enqueueOrderCreatedNotifications failed', eNot);
    }

    // 7) Notification temps réel pour le client (best effort, direct)
    try {
      const { notifyUser } = require('../services/notify');
      await notifyUser(req.user.id, 'ORDER_CREATED', { order_id: orderId, total: orderTotal });
    } catch {}

    // 8) Envoi WhatsApp au BACKOFFICE UNIQUEMENT (pas au client)
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
          to: BACKOFFICE_WHATSAPP,         // 👉 numéro interne
          name: fullName,
          orderId,
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
      status: 'OPEN',
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
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
    const cleanItems = [];

    for (const it of items) {
      const product_id = Number(it?.product_id);
      const qty = Number(it?.qty);
      if (!product_id || !qty) throw new Error('product_id & qty required');

      const [[p]] = await conn.query(
        `SELECT id, price FROM products WHERE id=?`,
        [product_id]
      );
      if (!p) throw new Error('Product not found: ' + product_id);

      const unit_price = Number(p.price);
      cleanItems.push({ product_id: p.id, qty, unit_price });
      itemsAmount += unit_price * qty;
    }

    const deliveryFee = Number(delivery?.fee || totals?.delivery_fee || 0);
    const currency = (delivery?.currency || totals?.currency || 'MAD').toUpperCase();
    const orderTotal = itemsAmount + deliveryFee;

    // 3) INSERT order invité
    const [r] = await conn.query(
      `
      INSERT INTO orders (user_id, status, address, contact, geo_link, total, currency, created_at, updated_at)
      VALUES (NULL, 'OPEN', ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        JSON.stringify(addressObj),
        JSON.stringify(contactObj),
        geoLink,
        orderTotal,
        currency,
      ]
    );
    const orderId = r.insertId;

    // 4) INSERT order_items
    for (const it of cleanItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price)
         VALUES (?,?,?,?)`,
        [orderId, it.product_id, it.qty, it.unit_price]
      );
    }

    await conn.commit();

    // 🔔 5) Enfiler des notifications pour vendeurs + admins
    try {
      await enqueueOrderCreatedNotifications(orderId, orderTotal, currency);
    } catch (eNot) {
      console.error('[Notify] enqueueOrderCreatedNotifications failed (guest)', eNot);
    }

    // 6) Envoi WhatsApp au BACKOFFICE UNIQUEMENT (pas au client)
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
          to: BACKOFFICE_WHATSAPP,        // 👉 numéro interne
          name: fullName,
          orderId,
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
      status: 'OPEN',
      total: orderTotal,
      currency,
      geo_link: geoLink || null,
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
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

    // ✅ Totaux pour le front (utiles pour livraison / total)
    const itemsAmount = result.items.reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.qty || 1),
      0
    );
    const totalAmount = Number(o.total || itemsAmount);
    const deliveryFee = Math.max(0, totalAmount - itemsAmount);
    const currency = (o.currency || 'MAD').toUpperCase();

    res.json({
      ...o,
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
        await notifyUser(order.user_id, 'ORDER_STATUS', { order_id: id, status });
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
        await notifyUser(order.user_id, 'ORDER_STATUS', { order_id: id, status: 'CANCELLED' });
      }
    } catch (eNot) {
      console.error('[Notify] ORDER_STATUS cancel failed', eNot);
    }

    res.json({ ok: true, status: 'CANCELLED' });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
