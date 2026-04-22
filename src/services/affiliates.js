const { getPool } = require("../lib/db");

function normalizeAffiliateCode(value) {
  const v = String(value || "").trim().toUpperCase();
  return v || null;
}

function computeAffiliateCommission(baseAmount, rate) {
  const base = Number(baseAmount || 0);
  const pct = Number(rate || 0);

  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;

  return +((base * pct) / 100).toFixed(2);
}

function normalizeProductId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

async function detectAffiliateOrderCols(conn) {
  const candidates = [
    "affiliate_id",
    "affiliate_code",
    "affiliate_commission_rate",
    "affiliate_commission_amount",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    affiliate_code: found.has("affiliate_code"),
    affiliate_commission_rate: found.has("affiliate_commission_rate"),
    affiliate_commission_amount: found.has("affiliate_commission_amount"),
  };
}

async function detectAffiliateCommissionCols(conn) {
  const candidates = [
    "affiliate_id",
    "order_id",
    "affiliate_code",
    "amount",
    "commission_rate",
    "base_amount",
    "status",
    "note",
    "product_id",
  ];

  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'affiliate_commissions'
        AND COLUMN_NAME IN (${candidates.map(() => "?").join(",")})
    `,
    candidates,
  );

  const found = new Set((rows || []).map((r) => r.COLUMN_NAME));

  return {
    affiliate_id: found.has("affiliate_id"),
    order_id: found.has("order_id"),
    affiliate_code: found.has("affiliate_code"),
    amount: found.has("amount"),
    commission_rate: found.has("commission_rate"),
    base_amount: found.has("base_amount"),
    status: found.has("status"),
    note: found.has("note"),
    product_id: found.has("product_id"),
  };
}

async function findActiveAffiliateByCode(conn, rawCode) {
  const code = normalizeAffiliateCode(rawCode);
  if (!code) return null;

  try {
    const [[row]] = await conn.query(
      `
        SELECT
          id,
          user_id,
          affiliate_code,
          referral_slug,
          commission_rate,
          status
        FROM affiliates
        WHERE affiliate_code = ?
          AND status = 'ACTIVE'
        LIMIT 1
      `,
      [code],
    );

    if (!row) return null;

    return {
      id: Number(row.id),
      user_id: Number(row.user_id || 0) || null,
      affiliate_code: normalizeAffiliateCode(row.affiliate_code),
      referral_slug: row.referral_slug || null,
      commission_rate: Number(row.commission_rate || 0),
      status: row.status || "INACTIVE",
    };
  } catch {
    return null;
  }
}

async function buildAffiliateOrderMeta(conn, affiliateCode, baseAmount) {
  const affiliate = await findActiveAffiliateByCode(conn, affiliateCode);
  const orderCols = await detectAffiliateOrderCols(conn);

  if (!affiliate) {
    return {
      affiliate: null,
      orderCols,
      orderMeta: {
        affiliate_id: null,
        affiliate_code: null,
        affiliate_commission_rate: 0,
        affiliate_commission_amount: 0,
      },
    };
  }

  const rate = Number(affiliate.commission_rate || 0);
  const amount = computeAffiliateCommission(baseAmount, rate);

  return {
    affiliate,
    orderCols,
    orderMeta: {
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.affiliate_code,
      affiliate_commission_rate: rate,
      affiliate_commission_amount: amount,
    },
  };
}

function pushAffiliateOrderColumns(
  cols,
  placeholders,
  vals,
  orderCols,
  orderMeta,
) {
  if (orderCols.affiliate_id) {
    cols.push("affiliate_id");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_id);
  }

  if (orderCols.affiliate_code) {
    cols.push("affiliate_code");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_code);
  }

  if (orderCols.affiliate_commission_rate) {
    cols.push("affiliate_commission_rate");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_commission_rate || 0);
  }

  if (orderCols.affiliate_commission_amount) {
    cols.push("affiliate_commission_amount");
    placeholders.push("?");
    vals.push(orderMeta.affiliate_commission_amount || 0);
  }
}

async function finalizeAffiliateOrder(
  conn,
  { affiliate, orderId, displayCode, baseAmount, orderMeta, productId = null },
) {
  if (!affiliate || !orderMeta?.affiliate_commission_amount) return;

  const commissionCols = await detectAffiliateCommissionCols(conn);
  const cleanProductId = normalizeProductId(productId);

  const cols = [];
  const vals = [];
  const qs = [];

  if (commissionCols.affiliate_id) {
    cols.push("affiliate_id");
    vals.push(affiliate.id);
    qs.push("?");
  }

  if (commissionCols.order_id) {
    cols.push("order_id");
    vals.push(orderId);
    qs.push("?");
  }

  if (commissionCols.affiliate_code) {
    cols.push("affiliate_code");
    vals.push(affiliate.affiliate_code);
    qs.push("?");
  }

  if (commissionCols.amount) {
    cols.push("amount");
    vals.push(Number(orderMeta.affiliate_commission_amount || 0));
    qs.push("?");
  }

  if (commissionCols.commission_rate) {
    cols.push("commission_rate");
    vals.push(Number(orderMeta.affiliate_commission_rate || 0));
    qs.push("?");
  }

  if (commissionCols.base_amount) {
    cols.push("base_amount");
    vals.push(Number(baseAmount || 0));
    qs.push("?");
  }

  if (commissionCols.product_id) {
    cols.push("product_id");
    vals.push(cleanProductId);
    qs.push("?");
  }

  if (commissionCols.status) {
    cols.push("status");
    vals.push("PENDING");
    qs.push("?");
  }

  if (commissionCols.note) {
    cols.push("note");
    vals.push(
      cleanProductId
        ? `Commission influenceur sur commande ${displayCode} - produit ${cleanProductId}`
        : `Commission influenceur sur commande ${displayCode}`,
    );
    qs.push("?");
  }

  if (cols.length) {
    await conn.query(
      `INSERT INTO affiliate_commissions (${cols.join(",")}) VALUES (${qs.join(",")})`,
      vals,
    );
  }

  try {
    await conn.query(
      `
        UPDATE affiliates
        SET total_orders = COALESCE(total_orders, 0) + 1,
            total_earnings = COALESCE(total_earnings, 0) + ?
        WHERE id = ?
      `,
      [Number(orderMeta.affiliate_commission_amount || 0), affiliate.id],
    );
  } catch {}
}

module.exports = {
  normalizeAffiliateCode,
  normalizeProductId,
  computeAffiliateCommission,
  findActiveAffiliateByCode,
  buildAffiliateOrderMeta,
  pushAffiliateOrderColumns,
  finalizeAffiliateOrder,
};