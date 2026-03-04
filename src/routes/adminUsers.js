// src/routes/adminUsers.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");

const router = Router();

function safeLike(v) {
  return `%${String(v || "").trim().replace(/[%_]/g, "\\$&")}%`;
}
function intOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : d;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Pagination locale (spécial users)
 * - accepte: page, pageSize, page_size, limit
 * - borne pageSize (max 2000)
 */
function getPaginationUsers(req) {
  const page = clamp(intOr(req.query.page, 1), 1, 1_000_000);
  const pageSizeRaw = req.query.pageSize ?? req.query.page_size ?? req.query.limit ?? 50;
  const pageSize = clamp(intOr(pageSizeRaw, 50), 1, 2000);
  const offset = (page - 1) * pageSize;
  const limit = pageSize;
  return { page, pageSize, offset, limit };
}

function buildPageInfo(total, page, pageSize) {
  const t = Number(total || 0);
  const totalSafe = Number.isFinite(t) && t >= 0 ? t : 0;
  const totalPages = pageSize > 0 ? Math.ceil(totalSafe / pageSize) : 0;
  return { total: totalSafe, page, pageSize, totalPages };
}

router.get("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const { page, pageSize, offset, limit } = getPaginationUsers(req);
  const pool = getPool();

  const q = String(req.query.q || "").trim();
  const role = String(req.query.role || "").trim().toUpperCase();
  const isActiveRaw = req.query.is_active ?? req.query.isActive ?? null;
  const isActive =
    isActiveRaw === null || isActiveRaw === undefined || isActiveRaw === ""
      ? null
      : Number(isActiveRaw);

  const includeOrders =
    String(req.query.include_orders ?? req.query.includeOrders ?? "0") === "1" ||
    String(req.query.include_orders ?? req.query.includeOrders ?? "0").toLowerCase() === "true";

  // -----------------------------
  // MODE 1: users uniquement
  // -----------------------------
  if (!includeOrders) {
    const where = [];
    const params = [];

    if (q) {
      const like = safeLike(q);
      const idNum = Number(q);
      if (Number.isFinite(idNum) && idNum > 0) {
        where.push(`(u.id = ? OR u.phone LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)`);
        params.push(idNum, like, like, like);
      } else {
        where.push(`(u.phone LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)`);
        params.push(like, like, like);
      }
    }

    if (role && role !== "ALL") {
      where.push(`u.role = ?`);
      params.push(role);
    }

    if (isActive === 0 || isActive === 1) {
      where.push(`COALESCE(u.is_active, 1) = ?`);
      params.push(isActive);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    try {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM users u ${whereSql}`,
        params
      );

      const [rows] = await pool.query(
        `
        SELECT
          u.id,
          u.phone,
          u.role,
          u.first_name,
          u.last_name,
          u.ville,
          u.commune,
          u.quartier,
          u.sexe,
          u.avatar,
          u.is_active,
          u.created_at,
          u.updated_at,
          1 AS has_account,
          0 AS from_orders
        FROM users u
        ${whereSql}
        ORDER BY u.first_name ASC, u.last_name ASC, u.phone ASC, u.id DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      return res.json({ items: rows || [], pageInfo: buildPageInfo(total, page, pageSize) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // -----------------------------
  // MODE 2: fusion users + guests orders (sans doublon)
  // -----------------------------
  const allowGuestsByRole =
    !role ||
    role === "ALL" ||
    role === "GUEST" ||
    role === "CLIENT" ||
    role === "CLIENTS" ||
    role === "MEMBER";

  // filtres USERS
  const whereUsers = [];
  const paramsUsers = [];

  if (q) {
    const like = safeLike(q);
    const idNum = Number(q);
    if (Number.isFinite(idNum) && idNum > 0) {
      whereUsers.push(`(u.id = ? OR u.phone LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)`);
      paramsUsers.push(idNum, like, like, like);
    } else {
      whereUsers.push(`(u.phone LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)`);
      paramsUsers.push(like, like, like);
    }
  }

  if (role && role !== "ALL" && role !== "GUEST" && role !== "CLIENT" && role !== "CLIENTS") {
    whereUsers.push(`u.role = ?`);
    paramsUsers.push(role);
  }

  if (isActive === 0 || isActive === 1) {
    whereUsers.push(`COALESCE(u.is_active, 1) = ?`);
    paramsUsers.push(isActive);
  }

  const whereUsersSql = whereUsers.length ? `WHERE ${whereUsers.join(" AND ")}` : "";

  // filtres GUESTS (orders)
  const whereGuests = [];
  const paramsGuests = [];

  whereGuests.push(`o.user_id IS NULL`);
  whereGuests.push(`o.contact IS NOT NULL`);
  whereGuests.push(`JSON_VALID(o.contact) = 1`);
  whereGuests.push(`NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.phone'))),'') IS NOT NULL`);

  if (q) {
    const like = safeLike(q);
    const idNum = Number(q);
    if (!(Number.isFinite(idNum) && idNum > 0)) {
      whereGuests.push(`
        (
          JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.phone')) LIKE ?
          OR JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.first_name')) LIKE ?
          OR JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.last_name')) LIKE ?
        )
      `);
      paramsGuests.push(like, like, like);
    } else {
      whereGuests.push(`1=0`);
    }
  }

  const whereGuestsSql = whereGuests.length ? `WHERE ${whereGuests.join(" AND ")}` : "";

  try {
    const unionSql = `
      SELECT
        dedupe_key,

        -- id user si existe, sinon 0 (guest)
        COALESCE(MAX(CASE WHEN source_rank = 0 THEN id END), 0) AS id,

        COALESCE(
          MAX(CASE WHEN source_rank = 0 THEN first_name END),
          MAX(CASE WHEN source_rank = 1 THEN first_name END),
          NULL
        ) AS first_name,

        COALESCE(
          MAX(CASE WHEN source_rank = 0 THEN last_name END),
          MAX(CASE WHEN source_rank = 1 THEN last_name END),
          NULL
        ) AS last_name,

        COALESCE(
          MAX(CASE WHEN source_rank = 0 THEN phone END),
          MAX(CASE WHEN source_rank = 1 THEN phone END),
          NULL
        ) AS phone,

        COALESCE(
          MAX(CASE WHEN source_rank = 0 THEN role END),
          MAX(CASE WHEN source_rank = 1 THEN role END),
          NULL
        ) AS role,

        MAX(CASE WHEN source_rank = 0 THEN ville END) AS ville,
        MAX(CASE WHEN source_rank = 0 THEN commune END) AS commune,
        MAX(CASE WHEN source_rank = 0 THEN quartier END) AS quartier,
        MAX(CASE WHEN source_rank = 0 THEN sexe END) AS sexe,
        MAX(CASE WHEN source_rank = 0 THEN avatar END) AS avatar,
        MAX(CASE WHEN source_rank = 0 THEN is_active END) AS is_active,
        MAX(CASE WHEN source_rank = 0 THEN created_at END) AS created_at,
        MAX(CASE WHEN source_rank = 0 THEN updated_at END) AS updated_at,

        CASE
          WHEN MAX(CASE WHEN source_rank = 0 THEN 1 ELSE 0 END) = 1 THEN 1
          ELSE 0
        END AS has_account,

        CASE
          WHEN MAX(CASE WHEN source_rank = 0 THEN 1 ELSE 0 END) = 1 THEN 0
          ELSE 1
        END AS from_orders,

        MAX(CASE WHEN source_rank = 1 THEN orders_count ELSE 0 END) AS orders_count
      FROM (
        -- USERS
        SELECT
          IF(
            NULLIF(TRIM(u.phone),'') IS NOT NULL,
            CONCAT('P:', TRIM(u.phone)),
            CONCAT('U:', u.id)
          ) AS dedupe_key,

          u.id AS id,
          NULLIF(TRIM(u.first_name),'') AS first_name,
          NULLIF(TRIM(u.last_name),'') AS last_name,
          NULLIF(TRIM(u.phone),'') AS phone,
          u.role AS role,
          u.ville AS ville,
          u.commune AS commune,
          u.quartier AS quartier,
          u.sexe AS sexe,
          u.avatar AS avatar,
          COALESCE(u.is_active, 1) AS is_active,
          u.created_at AS created_at,
          u.updated_at AS updated_at,

          0 AS source_rank,
          0 AS orders_count
        FROM users u
        ${whereUsersSql}

        ${allowGuestsByRole ? "UNION ALL" : ""}

        ${
          allowGuestsByRole
            ? `
        -- GUESTS from ORDERS
        SELECT
          CONCAT('P:', TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.phone')))) AS dedupe_key,

          0 AS id,
          NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.first_name'))),'') AS first_name,
          NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.last_name'))),'') AS last_name,
          NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.phone'))),'') AS phone,
          'GUEST' AS role,

          NULL AS ville,
          NULL AS commune,
          NULL AS quartier,
          NULL AS sexe,
          NULL AS avatar,
          NULL AS is_active,
          NULL AS created_at,
          NULL AS updated_at,

          1 AS source_rank,
          COUNT(*) AS orders_count
        FROM orders o
        ${whereGuestsSql}
        GROUP BY TRIM(JSON_UNQUOTE(JSON_EXTRACT(o.contact,'$.phone')))
        `
            : ""
        }
      ) t
      GROUP BY dedupe_key
    `;

    const allParams = [...paramsUsers, ...(allowGuestsByRole ? paramsGuests : [])];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM (${unionSql}) x`,
      allParams
    );

    const [rows] = await pool.query(
      `
      SELECT *
      FROM (${unionSql}) x
      ORDER BY
        x.has_account DESC,
        COALESCE(x.first_name,'') ASC,
        COALESCE(x.last_name,'') ASC,
        COALESCE(x.phone,'') ASC,
        COALESCE(x.id, 0) DESC
      LIMIT ? OFFSET ?
      `,
      [...allParams, limit, offset]
    );

    const clean = (rows || []).map((r) => {
      const { dedupe_key, ...rest } = r;
      return rest;
    });

    return res.json({ items: clean, pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;