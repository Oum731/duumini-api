// src/routes/operations.js
//
// Phase C : suivi d'actions/tâches (module "Operations" du classeur de
// gestion existant) — remplace le suivi manuel par ville/responsable.
// Outil de pilotage admin, comme Dépenses/Créances.
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { authRequired, isAdmin } = require("../middlewares/auth");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

const STATUSES = ["OPEN", "IN_PROGRESS", "DONE"];

function toPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/* =========================
 * GET /api/operations
 * ======================= */
router.get("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const { page, pageSize, offset, limit } = getPagination(req);
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  const city = req.query.city ? String(req.query.city).trim() : null;
  const responsibleUserId = req.query.responsible_user_id ? toPosInt(req.query.responsible_user_id) : null;

  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: "status invalide" });
  }

  try {
    const pool = getPool();
    const where = ["1=1"];
    const params = [];

    if (status) {
      where.push("o.status = ?");
      params.push(status);
    }
    if (city) {
      where.push("o.city LIKE ?");
      params.push(`%${city}%`);
    }
    if (responsibleUserId) {
      where.push("o.responsible_user_id = ?");
      params.push(responsibleUserId);
    }

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM operations o WHERE ${whereSql}`,
      params,
    );

    const [rows] = await pool.query(
      `
      SELECT o.id, o.op_date, o.subject, o.city, o.type, o.responsible_user_id,
             o.status, o.due_date, o.resolution, o.created_by, o.created_at, o.updated_at,
             ru.first_name AS responsible_first_name, ru.last_name AS responsible_last_name,
             cu.first_name AS created_by_first_name, cu.last_name AS created_by_last_name
      FROM operations o
      LEFT JOIN users ru ON ru.id = o.responsible_user_id
      LEFT JOIN users cu ON cu.id = o.created_by
      WHERE ${whereSql}
      ORDER BY
        (o.status = 'DONE') ASC,
        (o.due_date IS NULL) ASC, o.due_date ASC,
        o.op_date DESC, o.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    return res.json({ items: rows || [], pageInfo: buildPageInfo(total, page, pageSize) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * POST /api/operations
 * ======================= */
router.post("/", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const opDate = req.body?.op_date ? String(req.body.op_date).slice(0, 10) : null;
  const subject = req.body?.subject ? String(req.body.subject).trim() : "";
  const city = req.body?.city ? String(req.body.city).trim() : null;
  const type = req.body?.type ? String(req.body.type).trim() : null;
  const responsibleUserId = req.body?.responsible_user_id ? toPosInt(req.body.responsible_user_id) : null;
  const dueDate = req.body?.due_date ? String(req.body.due_date).slice(0, 10) : null;
  const resolution = req.body?.resolution ? String(req.body.resolution).trim() : null;

  if (!opDate) return res.status(400).json({ error: "op_date is required" });
  if (!subject) return res.status(400).json({ error: "subject is required" });

  try {
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO operations
        (op_date, subject, city, type, responsible_user_id, status, due_date, resolution, created_by)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      [opDate, subject, city, type, responsibleUserId, dueDate, resolution, req.user.id],
    );
    return res.status(201).json({ id: r.insertId, ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * PUT /api/operations/:id
 * ======================= */
router.put("/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const { subject, city, type, responsible_user_id, status, due_date, resolution, op_date } = req.body || {};

  if (status !== undefined && !STATUSES.includes(String(status).toUpperCase())) {
    return res.status(400).json({ error: "status invalide" });
  }

  try {
    await getPool().query(
      `UPDATE operations SET
         op_date              = COALESCE(?, op_date),
         subject              = COALESCE(?, subject),
         city                 = CASE WHEN ? THEN ? ELSE city END,
         type                 = CASE WHEN ? THEN ? ELSE type END,
         responsible_user_id  = CASE WHEN ? THEN ? ELSE responsible_user_id END,
         status               = COALESCE(?, status),
         due_date             = CASE WHEN ? THEN ? ELSE due_date END,
         resolution           = CASE WHEN ? THEN ? ELSE resolution END
       WHERE id = ?`,
      [
        op_date ? String(op_date).slice(0, 10) : null,
        subject ? String(subject).trim() : null,

        city !== undefined, city ? String(city).trim() : null,
        type !== undefined, type ? String(type).trim() : null,
        responsible_user_id !== undefined, responsible_user_id ? toPosInt(responsible_user_id) : null,

        status ? String(status).toUpperCase() : null,

        due_date !== undefined, due_date ? String(due_date).slice(0, 10) : null,
        resolution !== undefined, resolution ? String(resolution).trim() : null,

        id,
      ],
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
 * DELETE /api/operations/:id
 * ======================= */
router.delete("/:id", authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });

  const id = toPosInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    await getPool().query(`DELETE FROM operations WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
