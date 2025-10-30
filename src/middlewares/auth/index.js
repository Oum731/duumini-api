// src/middlewares/auth.js
const { verifyAccess } = require("../../utils/jwt");
const { getPool } = require("../lib/db"); // <-- ajoute ceci

async function attachUserOrThrow(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error("No token");
    err.status = 401;
    throw err;
  }
  let payload;
  try {
    payload = verifyAccess(token);
  } catch (e) {
    const err = new Error("Invalid token");
    err.status = 401;
    throw err;
  }

  // ✅ Relire depuis la BDD (source de vérité)
  const id = payload.id ?? payload.sub ?? payload.user_id;
  const pool = getPool();
  const [rows] = await pool.query("SELECT id, phone, role FROM users WHERE id=? LIMIT 1", [id]);
  const u = rows && rows[0];
  if (!u) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  req.user = { id: u.id, uid: String(u.id), role: String(u.role) };
}
