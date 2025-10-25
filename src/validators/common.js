// src/validators/common.js
function str(v, d = "") {
  return typeof v === "string" ? v.trim() : d;
}
function int(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string")
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return d;
}
function notEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}
module.exports = { str, int, bool, notEmpty };
