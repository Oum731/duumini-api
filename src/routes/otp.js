// src/routes/otp.js
const { Router } = require("express");
const bcrypt = require("bcryptjs");
const { getPool } = require("../lib/db");
const { sendOtpStart, checkOtpCode } = require("../lib/twilio");
const router = Router();

const otpVerified = new Map(); // phone -> { purpose, exp }
const WINDOW_MS = 5 * 60 * 1000;

function markPhoneVerified(phone, purpose) {
  otpVerified.set(phone, { purpose, exp: Date.now() + WINDOW_MS });
}
function isPhoneVerified(phone, purpose) {
  const entry = otpVerified.get(phone);
  if (!entry) return false;
  if (entry.purpose !== purpose) return false;
  if (Date.now() > entry.exp) { otpVerified.delete(phone); return false; }
  return true;
}
function clearPhoneVerified(phone) { otpVerified.delete(phone); }

router.post("/otp/start", async (req, res) => {
  try {
    const { phone, purpose = "reset" } = req.body || {};
    if (typeof phone !== "string" || !/^\+2126\d{8}$/.test(phone)) {
      return res.status(400).json({ error: "Téléphone invalide (+2126XXXXXXXX)" });
    }
    await sendOtpStart(phone, purpose);
    res.json({ ok: true, message: "Code envoyé" });
  } catch (e) {
    console.error("otp/start error:", e);
    res.status(500).json({ error: "Envoi OTP impossible" });
  }
});

router.post("/otp/verify", async (req, res) => {
  try {
    const { phone, code, purpose = "reset" } = req.body || {};
    if (typeof phone !== "string" || !/^\+2126\d{8}$/.test(phone)) {
      return res.status(400).json({ error: "Téléphone invalide" });
    }
    if (typeof code !== "string" || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: "Code invalide" });
    }
    const { valid } = await checkOtpCode(phone, code);
    if (!valid) return res.status(400).json({ error: "Code incorrect ou expiré" });

    markPhoneVerified(phone, purpose);
    res.json({ ok: true, message: "Code validé" });
  } catch (e) {
    console.error("otp/verify error:", e);
    res.status(500).json({ error: "Vérification OTP impossible" });
  }
});

router.post("/password/reset", async (req, res) => {
  try {
    const { phone, new_password } = req.body || {};
    if (typeof phone !== "string" || !/^\+2126\d{8}$/.test(phone)) {
      return res.status(400).json({ error: "Téléphone invalide" });
    }
    if (typeof new_password !== "string" || !/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(new_password)) {
      return res.status(400).json({ error: "Mot de passe trop faible" });
    }
    if (!isPhoneVerified(phone, "reset")) {
      return res.status(403).json({ error: "OTP non validé ou expiré" });
    }

    const hash = await bcrypt.hash(new_password, 10);
    const pool = getPool();
    const [result] = await pool.query(
      // 👇 colonne correcte
      "UPDATE users SET password = ? WHERE phone = ? LIMIT 1",
      [hash, phone]
    );
    clearPhoneVerified(phone);

    if (!result.affectedRows) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ ok: true, message: "Mot de passe mis à jour" });
  } catch (e) {
    console.error("password/reset error:", e);
    res.status(500).json({ error: "Impossible de mettre à jour le mot de passe" });
  }
});

module.exports = router;
