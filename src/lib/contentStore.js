// src/lib/contentStore.js
const { getPool } = require("./db");

function json(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

async function upsertDraft({ type, slug, lang = "fr", data, score, created_by = "agent" }) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const t = String(type || "").trim();
    const s = String(slug || "").trim();
    const l = String(lang || "fr").trim();

    if (!t || !s) throw new Error("upsertDraft: type/slug requis");

    // get existing
    const [rows] = await conn.query(
      `SELECT id, status, data_json, score FROM content_items WHERE type=? AND slug=? AND lang=? LIMIT 1`,
      [t, s, l]
    );

    if (!rows.length) {
      const [ins] = await conn.query(
        `INSERT INTO content_items (type, slug, lang, status, data_json, score, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [t, s, l, "draft", JSON.stringify(data || {}), score ?? null, created_by]
      );

      const id = ins.insertId;

      await conn.query(
        `INSERT INTO content_versions (content_item_id, data_json, score_before, score_after, reason, created_by)
         VALUES (?,?,?,?,?,?)`,
        [id, JSON.stringify(data || {}), null, score ?? null, "AI_DRAFT_CREATED", created_by]
      );

      return { id, type: t, slug: s, lang: l, status: "draft" };
    }

    const item = rows[0];
    const beforeScore = item.score != null ? Number(item.score) : null;

    await conn.query(
      `UPDATE content_items SET status='draft', data_json=?, score=?, updated_at=NOW() WHERE id=?`,
      [JSON.stringify(data || {}), score ?? null, item.id]
    );

    await conn.query(
      `INSERT INTO content_versions (content_item_id, data_json, score_before, score_after, reason, created_by)
       VALUES (?,?,?,?,?,?)`,
      [item.id, JSON.stringify(data || {}), beforeScore, score ?? null, "AI_DRAFT_UPDATED", created_by]
    );

    return { id: item.id, type: t, slug: s, lang: l, status: "draft" };
  } finally {
    conn.release();
  }
}

async function listContent({ status, type, lang, q, limit = 50, offset = 0 } = {}) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const where = [];
    const args = [];

    if (status) {
      where.push("status=?");
      args.push(String(status));
    }
    if (type) {
      where.push("type=?");
      args.push(String(type));
    }
    if (lang) {
      where.push("lang=?");
      args.push(String(lang));
    }
    if (q) {
      where.push("(slug LIKE ?)");
      args.push(`%${String(q)}%`);
    }

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await conn.query(
      `SELECT id, type, slug, lang, status, score, created_by, created_at, updated_at, published_at
       FROM content_items
       ${sqlWhere}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
      [...args, Number(limit) || 50, Number(offset) || 0]
    );

    return rows;
  } finally {
    conn.release();
  }
}

async function getContent(id) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, type, slug, lang, status, score, data_json, created_by, created_at, updated_at, published_at
       FROM content_items WHERE id=? LIMIT 1`,
      [Number(id)]
    );
    if (!rows.length) return null;
    const r = rows[0];
    r.data = json(r.data_json);
    delete r.data_json;
    return r;
  } finally {
    conn.release();
  }
}

async function publishContent(id, by = "admin") {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, status, score, data_json FROM content_items WHERE id=? LIMIT 1`,
      [Number(id)]
    );
    if (!rows.length) return null;

    const item = rows[0];
    const beforeStatus = String(item.status || "");

    await conn.query(
      `UPDATE content_items SET status='published', published_at=NOW(), updated_at=NOW(), created_by=created_by WHERE id=?`,
      [item.id]
    );

    await conn.query(
      `INSERT INTO content_versions (content_item_id, data_json, score_before, score_after, reason, created_by)
       VALUES (?,?,?,?,?,?)`,
      [item.id, item.data_json, item.score ?? null, item.score ?? null, `PUBLISHED_FROM_${beforeStatus.toUpperCase()}`, by]
    );

    return { ok: true, id: item.id };
  } finally {
    conn.release();
  }
}

async function unpublishContent(id, by = "admin") {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, status, score, data_json FROM content_items WHERE id=? LIMIT 1`,
      [Number(id)]
    );
    if (!rows.length) return null;
    const item = rows[0];

    await conn.query(
      `UPDATE content_items SET status='draft', updated_at=NOW() WHERE id=?`,
      [item.id]
    );

    await conn.query(
      `INSERT INTO content_versions (content_item_id, data_json, score_before, score_after, reason, created_by)
       VALUES (?,?,?,?,?,?)`,
      [item.id, item.data_json, item.score ?? null, item.score ?? null, "UNPUBLISHED_TO_DRAFT", by]
    );

    return { ok: true, id: item.id };
  } finally {
    conn.release();
  }
}

async function listVersions(id, limit = 50) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, content_item_id, score_before, score_after, reason, created_by, created_at
       FROM content_versions
       WHERE content_item_id=?
       ORDER BY id DESC
       LIMIT ?`,
      [Number(id), Number(limit) || 50]
    );
    return rows;
  } finally {
    conn.release();
  }
}

async function rollbackToVersion(contentId, versionId, by = "admin") {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [vrows] = await conn.query(
      `SELECT id, content_item_id, data_json, score_after FROM content_versions
       WHERE id=? AND content_item_id=? LIMIT 1`,
      [Number(versionId), Number(contentId)]
    );
    if (!vrows.length) return null;

    const v = vrows[0];

    await conn.query(
      `UPDATE content_items SET status='draft', data_json=?, score=?, updated_at=NOW() WHERE id=?`,
      [v.data_json, v.score_after ?? null, Number(contentId)]
    );

    await conn.query(
      `INSERT INTO content_versions (content_item_id, data_json, score_before, score_after, reason, created_by)
       VALUES (?,?,?,?,?,?)`,
      [Number(contentId), v.data_json, null, v.score_after ?? null, `ROLLBACK_TO_VERSION_${v.id}`, by]
    );

    return { ok: true, id: Number(contentId), version: Number(versionId) };
  } finally {
    conn.release();
  }
}

/**
 * Public content fetcher (front should use this):
 * get published content by type/slug/lang
 */
async function getPublishedBySlug({ type, slug, lang = "fr" }) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, type, slug, lang, status, score, data_json, updated_at, published_at
       FROM content_items
       WHERE type=? AND slug=? AND lang=? AND status='published'
       LIMIT 1`,
      [String(type), String(slug), String(lang)]
    );
    if (!rows.length) return null;
    const r = rows[0];
    r.data = json(r.data_json);
    delete r.data_json;
    return r;
  } finally {
    conn.release();
  }
}

module.exports = {
  upsertDraft,
  listContent,
  getContent,
  publishContent,
  unpublishContent,
  listVersions,
  rollbackToVersion,
  getPublishedBySlug,
};
