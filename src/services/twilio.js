// src/services/twilio.js
const twilio = require("twilio");
const { env } = require("../lib/env"); // ← CORRIGÉ: remonte d'un dossier

const DEV_MODE = (env.NODE_ENV || "development") !== "production";
const DEV_TEST_CODE = process.env.OTP_TEST_CODE || "000000";

let client = null;
if (!DEV_MODE) {
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_ACCOUNT_SID) {
    client = twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, { accountSid: env.TWILIO_ACCOUNT_SID });
    console.log("[Twilio] Using API Key auth");
  } else if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    console.log("[Twilio] Using Account SID + Auth Token");
  }
}

async function sendOtpStart(phone, purpose = "signup") {
  if (DEV_MODE && DEV_TEST_CODE) {
    console.log(`[Twilio DEV] OTP simulé pour ${phone}: ${DEV_TEST_CODE} (purpose=${purpose})`);
    return { sid: "dev", status: "approved", to: phone, purpose };
  }
  if (!client || !env.TWILIO_VERIFY_SID) throw new Error("Twilio not configured");
  const res = await client.verify.v2.services(env.TWILIO_VERIFY_SID)
    .verifications.create({ to: phone, channel: "sms", locale: "fr" });
  return { sid: res.sid, status: res.status, to: res.to, purpose };
}

async function checkOtpCode(phone, code) {
  if (DEV_MODE && DEV_TEST_CODE && code === DEV_TEST_CODE) return { status: "approved", valid: true };
  if (!client || !env.TWILIO_VERIFY_SID) throw new Error("Twilio not configured");
  const res = await client.verify.v2.services(env.TWILIO_VERIFY_SID)
    .verificationChecks.create({ to: phone, code });
  return { status: res.status, valid: res.status === "approved" };
}

module.exports = { sendOtpStart, checkOtpCode };
