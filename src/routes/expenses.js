const express = require("express");
const { getPool } = require("../lib/db");
const auth = require("../middlewares/auth");

const router = express.Router();

const authRequired = auth.authRequired;
const isAdmin = auth.isAdmin || (() => false);
const isVendor = auth.isVendor || (() => false);
const isRestaurant = auth.isRestaurant || (() => false);
const isSupplier = auth.isSupplier || (() => false);

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(v, max = 255) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function normalizeDateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function generateExpenseReference() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `DEP-${yyyy}${mm}${dd}-${rand}`;
}

async function generateUniqueExpenseReference(pool) {
  for (let i = 0; i < 10; i += 1) {
    const ref = generateExpenseReference();
    const [[existing]] = await pool.query(
      `
      SELECT id
      FROM expenses
      WHERE reference = ?
      LIMIT 1
      `,
      [ref]
    );
    if (!existing) return ref;
  }
  return `DEP-${Date.now()}`;
}

function canManageExpenses(req) {
  return (
    isAdmin(req.user) ||
    isVendor(req.user) ||
    isRestaurant(req.user) ||
    isSupplier(req.user)
  );
}

// ✅ req.user n'a jamais de `shop_id` réel (seulement `effective_shop_id`
// en impersonation admin) : on résout la boutique du vendeur/fournisseur/
// restaurant connecté via owner_id, comme le fait déjà shops.js (/mine).
async function resolveOwnShopId(pool, userId) {
  const uid = toNum(userId, 0) || null;
  if (!uid) return null;
  const [[row]] = await pool.query(
    "SELECT id FROM shops WHERE owner_id = ? ORDER BY id ASC LIMIT 1",
    [uid]
  );
  return row?.id ? Number(row.id) : null;
}

async function requestShopId(req, pool) {
  if (isAdmin(req.user)) {
    return toNum(req.query.shop_id || req.body?.shop_id, 0) || null;
  }
  return resolveOwnShopId(pool, req.user?.id);
}

async function forbiddenByRole(req, shopId, pool) {
  if (isAdmin(req.user)) return false;
  const myShopId = await resolveOwnShopId(pool, req.user?.id);
  if (!myShopId || !shopId) return false;
  return Number(myShopId) !== Number(shopId);
}

async function buildExpenseWhere({ query = {}, user = null, pool }) {
  const where = [];
  const params = [];

  const shopId = isAdmin(user)
    ? toNum(query.shop_id, 0) || null
    : await resolveOwnShopId(pool, user?.id);

  const categoryId = toNum(query.category_id, 0);
  const categoryName = cleanStr(query.category_name, 100);
  const status = cleanStr(query.status, 20);
  const paymentMethod = cleanStr(query.payment_method, 50);
  const q = cleanStr(query.q, 255);
  const from = normalizeDateOnly(query.from);
  const to = normalizeDateOnly(query.to);

  if (shopId) {
    where.push("e.shop_id = ?");
    params.push(shopId);
  }

  if (categoryId > 0) {
    where.push("e.category_id = ?");
    params.push(categoryId);
  }

  if (categoryName) {
    where.push("e.category_name = ?");
    params.push(categoryName);
  }

  if (status) {
    where.push("e.status = ?");
    params.push(status.toUpperCase());
  }

  if (paymentMethod) {
    where.push("e.payment_method = ?");
    params.push(paymentMethod);
  }

  if (from) {
    where.push("e.expense_date >= ?");
    params.push(from);
  }

  if (to) {
    where.push("e.expense_date <= ?");
    params.push(to);
  }

  if (q) {
    where.push(
      "(e.label LIKE ? OR e.description LIKE ? OR e.reference LIKE ? OR e.category_name LIKE ?)"
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  return { where, params };
}

async function resolveCategory(pool, categoryId, fallbackName) {
  if (categoryId > 0) {
    const [[row]] = await pool.query(
      `
      SELECT id, name
      FROM expense_categories
      WHERE id = ? AND is_active = 1
      LIMIT 1
      `,
      [categoryId]
    );

    if (row) {
      return {
        category_id: row.id,
        category_name: row.name,
      };
    }
  }

  const name = cleanStr(fallbackName, 100);
  if (!name) return null;

  return {
    category_id: null,
    category_name: name,
  };
}

function normalizeExpenseRow(r) {
  return {
    ...r,
    amount: Number(r?.amount || 0),
    category_color: r?.category_color || null,
    created_at: r?.created_at || null,
    updated_at: r?.updated_at || null,
  };
}

async function queryExpenseList(pool, whereSql, params, pageSize, offset) {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        e.id,
        e.shop_id,
        e.user_id,
        e.category_id,
        e.category_name,
        e.label,
        e.description,
        e.amount,
        e.expense_date,
        e.payment_method,
        e.reference,
        e.status,
        e.receipt_url,
        e.created_at,
        e.updated_at,
        c.color AS category_color
      FROM expenses e
      LEFT JOIN expense_categories c ON c.id = e.category_id
      ${whereSql}
      ORDER BY e.expense_date DESC, e.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );

    return rows;
  } catch (e) {
    const [rows] = await pool.query(
      `
      SELECT
        e.id,
        e.shop_id,
        e.user_id,
        e.category_id,
        e.category_name,
        e.label,
        e.description,
        e.amount,
        e.expense_date,
        e.payment_method,
        e.reference,
        e.status,
        e.receipt_url,
        e.created_at,
        e.updated_at,
        NULL AS category_color
      FROM expenses e
      ${whereSql}
      ORDER BY e.expense_date DESC, e.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );

    return rows;
  }
}

router.get("/", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const { where, params } = await buildExpenseWhere({
      query: req.query,
      user: req.user,
      pool,
    });

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let total = 0;
    let rows = [];

    try {
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM expenses e ${whereSql}`,
        params
      );
      total = Number(countRow?.total || 0);

      rows = await queryExpenseList(pool, whereSql, params, pageSize, offset);
    } catch (err) {
      console.error("GET /expenses fallback error:", {
        message: err?.message,
        sqlMessage: err?.sqlMessage,
        code: err?.code,
      });

      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM expenses e ${whereSql}`,
        params
      );
      total = Number(countRow?.total || 0);

      const [data] = await pool.query(
        `
        SELECT
          e.id,
          e.shop_id,
          e.user_id,
          e.category_id,
          e.category_name,
          e.label,
          e.description,
          e.amount,
          e.expense_date,
          e.payment_method,
          e.reference,
          e.status,
          e.receipt_url,
          e.created_at,
          e.updated_at,
          NULL AS category_color
        FROM expenses e
        ${whereSql}
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT ? OFFSET ?
        `,
        [...params, pageSize, offset]
      );

      rows = data;
    }

    return res.json({
      items: Array.isArray(rows) ? rows.map(normalizeExpenseRow) : [],
      pageInfo: {
        page,
        pageSize,
        total,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (e) {
    console.error("ERROR EXPENSES:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
      errno: e?.errno,
      stack: e?.stack,
    });

    return res.status(500).json({
      error: "Erreur serveur lors du chargement des dépenses.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.get("/summary", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();
    const { where, params } = await buildExpenseWhere({ query: req.query, user: req.user, pool });
    const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

    const [[row]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN e.expense_date = CURDATE() THEN e.amount ELSE 0 END), 0) AS today,
        COALESCE(SUM(CASE WHEN YEARWEEK(e.expense_date, 1) = YEARWEEK(CURDATE(), 1) THEN e.amount ELSE 0 END), 0) AS week,
        COALESCE(SUM(CASE WHEN YEAR(e.expense_date) = YEAR(CURDATE()) AND MONTH(e.expense_date) = MONTH(CURDATE()) THEN e.amount ELSE 0 END), 0) AS month,
        COALESCE(SUM(CASE WHEN YEAR(e.expense_date) = YEAR(CURDATE()) THEN e.amount ELSE 0 END), 0) AS year,
        COALESCE(SUM(e.amount), 0) AS filtered_total
      FROM expenses e
      WHERE 1=1
      ${whereSql}
      `,
      params
    );

    return res.json({
      today: Number(row?.today || 0),
      week: Number(row?.week || 0),
      month: Number(row?.month || 0),
      year: Number(row?.year || 0),
      filtered_total: Number(row?.filtered_total || 0),
    });
  } catch (e) {
    console.error("GET /expenses/summary error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
    });

    return res.status(500).json({
      error: "Erreur serveur lors du calcul du résumé.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.get("/grouped", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const period = String(req.query.period || "month").toLowerCase();
    const pool = getPool();
    const { where, params } = await buildExpenseWhere({ query: req.query, user: req.user, pool });

    let selectPeriod = "DATE_FORMAT(e.expense_date, '%Y-%m-%d')";
    if (period === "week") {
      selectPeriod = "CONCAT(YEAR(e.expense_date), '-S', LPAD(WEEK(e.expense_date, 1), 2, '0'))";
    } else if (period === "month") {
      selectPeriod = "DATE_FORMAT(e.expense_date, '%Y-%m')";
    } else if (period === "year") {
      selectPeriod = "DATE_FORMAT(e.expense_date, '%Y')";
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `
      SELECT
        ${selectPeriod} AS period,
        COALESCE(SUM(e.amount), 0) AS total,
        COUNT(*) AS count_items
      FROM expenses e
      ${whereSql}
      GROUP BY period
      ORDER BY period ASC
      `,
      params
    );

    return res.json({
      period,
      items: Array.isArray(rows)
        ? rows.map((r) => ({
            period: r.period,
            total: Number(r.total || 0),
            count_items: Number(r.count_items || 0),
          }))
        : [],
    });
  } catch (e) {
    console.error("GET /expenses/grouped error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
    });

    return res.status(500).json({
      error: "Erreur serveur lors du regroupement des dépenses.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.get("/by-category", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();
    const { where, params } = await buildExpenseWhere({ query: req.query, user: req.user, pool });
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let rows;
    try {
      [rows] = await pool.query(
        `
        SELECT
          e.category_id,
          e.category_name,
          COALESCE(SUM(e.amount), 0) AS total,
          COUNT(*) AS count_items,
          MAX(c.color) AS color
        FROM expenses e
        LEFT JOIN expense_categories c ON c.id = e.category_id
        ${whereSql}
        GROUP BY e.category_id, e.category_name
        ORDER BY total DESC, e.category_name ASC
        `,
        params
      );
    } catch {
      [rows] = await pool.query(
        `
        SELECT
          e.category_id,
          e.category_name,
          COALESCE(SUM(e.amount), 0) AS total,
          COUNT(*) AS count_items,
          NULL AS color
        FROM expenses e
        ${whereSql}
        GROUP BY e.category_id, e.category_name
        ORDER BY total DESC, e.category_name ASC
        `,
        params
      );
    }

    return res.json({
      items: Array.isArray(rows)
        ? rows.map((r) => ({
            category_id: r.category_id,
            category_name: r.category_name,
            total: Number(r.total || 0),
            count_items: Number(r.count_items || 0),
            color: r.color || null,
          }))
        : [],
    });
  } catch (e) {
    console.error("GET /expenses/by-category error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
    });

    return res.status(500).json({
      error: "Erreur serveur lors du calcul par catégorie.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.post("/", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const pool = getPool();
    const shopId = await requestShopId(req, pool);
    const userId = toNum(req.user?.id, 0) || null;
    const categoryId = toNum(req.body?.category_id, 0);
    const categoryFallback = cleanStr(req.body?.category_name, 100);
    const label = cleanStr(req.body?.label, 255);
    const description = cleanStr(req.body?.description, 5000);
    const amount = toNum(req.body?.amount, NaN);
    const expenseDate = normalizeDateOnly(req.body?.expense_date);
    const paymentMethod = cleanStr(req.body?.payment_method, 50);
    const status = String(req.body?.status || "PAID").toUpperCase();
    const receiptUrl = cleanStr(req.body?.receipt_url, 1000);

    if (!label) return res.status(400).json({ error: "Le libellé est obligatoire." });
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "Montant invalide." });
    }
    if (!expenseDate) return res.status(400).json({ error: "Date invalide." });
    if (!["PAID", "PENDING"].includes(status)) {
      return res.status(400).json({ error: "Statut invalide." });
    }

    const category = await resolveCategory(pool, categoryId, categoryFallback);
    if (!category?.category_name) {
      return res.status(400).json({ error: "La catégorie est obligatoire." });
    }

    const reference = await generateUniqueExpenseReference(pool);

    const [result] = await pool.query(
      `
      INSERT INTO expenses (
        shop_id,
        user_id,
        category_id,
        category_name,
        label,
        description,
        amount,
        expense_date,
        payment_method,
        reference,
        status,
        receipt_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        shopId,
        userId,
        category.category_id,
        category.category_name,
        label,
        description,
        amount,
        expenseDate,
        paymentMethod,
        reference,
        status,
        receiptUrl,
      ]
    );

    const rows = await queryExpenseList(pool, "WHERE e.id = ?", [result.insertId], 1, 0);
    return res.status(201).json(normalizeExpenseRow(rows?.[0] || {}));
  } catch (e) {
    console.error("POST /expenses error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
      stack: e?.stack,
    });

    return res.status(500).json({
      error: "Erreur serveur lors de la création de la dépense.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.put("/:id", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const id = toNum(req.params.id, 0);
    if (!id) return res.status(400).json({ error: "ID invalide." });

    const pool = getPool();

    const [[existing]] = await pool.query(
      `
      SELECT id, shop_id, reference
      FROM expenses
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!existing) return res.status(404).json({ error: "Dépense introuvable." });
    if (await forbiddenByRole(req, existing.shop_id, pool)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const categoryId = toNum(req.body?.category_id, 0);
    const categoryFallback = cleanStr(req.body?.category_name, 100);
    const label = cleanStr(req.body?.label, 255);
    const description = cleanStr(req.body?.description, 5000);
    const amount = toNum(req.body?.amount, NaN);
    const expenseDate = normalizeDateOnly(req.body?.expense_date);
    const paymentMethod = cleanStr(req.body?.payment_method, 50);
    const status = String(req.body?.status || "").toUpperCase();
    const receiptUrl = cleanStr(req.body?.receipt_url, 1000);

    if (!label) return res.status(400).json({ error: "Le libellé est obligatoire." });
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "Montant invalide." });
    }
    if (!expenseDate) return res.status(400).json({ error: "Date invalide." });
    if (!["PAID", "PENDING"].includes(status)) {
      return res.status(400).json({ error: "Statut invalide." });
    }

    const category = await resolveCategory(pool, categoryId, categoryFallback);
    if (!category?.category_name) {
      return res.status(400).json({ error: "La catégorie est obligatoire." });
    }

    const reference = existing.reference || (await generateUniqueExpenseReference(pool));

    await pool.query(
      `
      UPDATE expenses
      SET
        category_id = ?,
        category_name = ?,
        label = ?,
        description = ?,
        amount = ?,
        expense_date = ?,
        payment_method = ?,
        reference = ?,
        status = ?,
        receipt_url = ?
      WHERE id = ?
      `,
      [
        category.category_id,
        category.category_name,
        label,
        description,
        amount,
        expenseDate,
        paymentMethod,
        reference,
        status,
        receiptUrl,
        id,
      ]
    );

    const rows = await queryExpenseList(pool, "WHERE e.id = ?", [id], 1, 0);
    return res.json(normalizeExpenseRow(rows?.[0] || {}));
  } catch (e) {
    console.error("PUT /expenses/:id error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
      stack: e?.stack,
    });

    return res.status(500).json({
      error: "Erreur serveur lors de la mise à jour.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

router.delete("/:id", authRequired, async (req, res) => {
  try {
    if (!canManageExpenses(req)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const id = toNum(req.params.id, 0);
    if (!id) return res.status(400).json({ error: "ID invalide." });

    const pool = getPool();

    const [[existing]] = await pool.query(
      `
      SELECT id, shop_id
      FROM expenses
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!existing) return res.status(404).json({ error: "Dépense introuvable." });
    if (await forbiddenByRole(req, existing.shop_id, pool)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    await pool.query(`DELETE FROM expenses WHERE id = ?`, [id]);

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("DELETE /expenses/:id error:", {
      message: e?.message,
      sqlMessage: e?.sqlMessage,
      code: e?.code,
    });

    return res.status(500).json({
      error: "Erreur serveur lors de la suppression.",
      details: e?.sqlMessage || e?.message || "unknown_error",
    });
  }
});

module.exports = router;