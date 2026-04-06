const express = require("express");
const { getPool } = require("../lib/db");
const { authRequired, requireRole } = require("../middlewares/auth");

const router = express.Router();

function normalizeClosedMessage(value) {
  const s = String(value || "").trim();
  if (!s) {
    return "Le site est temporairement fermé. Merci de revenir plus tard.";
  }
  return s;
}

async function getSetting(conn, key, fallback = null) {
  const [[row]] = await conn.query(
    `SELECT setting_value FROM app_settings WHERE setting_key=? LIMIT 1`,
    [key]
  );
  if (!row) return fallback;
  return row.setting_value ?? fallback;
}

async function setSetting(conn, key, value) {
  await conn.query(
    `
    INSERT INTO app_settings (setting_key, setting_value)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
    `,
    [key, value]
  );
}

router.get(
  "/site-status",
  authRequired,
  requireRole("ADMIN"),
  async (req, res, next) => {
    const conn = await getPool().getConnection();
    try {
      const isClosedRaw = await getSetting(conn, "site_closed", "0");
      const messageRaw = await getSetting(
        conn,
        "site_closed_message",
        "Le site est temporairement fermé. Merci de revenir plus tard."
      );

      res.json({
        is_closed: String(isClosedRaw || "0") === "1",
        message: normalizeClosedMessage(messageRaw),
      });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

router.put(
  "/site-status",
  authRequired,
  requireRole("ADMIN"),
  express.json(),
  async (req, res, next) => {
    const conn = await getPool().getConnection();
    try {
      const isClosed =
        String(req.body?.is_closed ?? "").trim() === "true" ||
        String(req.body?.is_closed ?? "").trim() === "1" ||
        req.body?.is_closed === true;

      const message = normalizeClosedMessage(req.body?.message);

      await setSetting(conn, "site_closed", isClosed ? "1" : "0");
      await setSetting(conn, "site_closed_message", message);

      res.json({
        ok: true,
        is_closed: isClosed,
        message,
      });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

module.exports = router;