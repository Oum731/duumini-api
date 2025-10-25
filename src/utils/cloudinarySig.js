const crypto = require("crypto");
const { env } = require("../lib/env");

/** Génère une signature v2 Cloudinary à partir de params (sans signature/api_key) */
function signCloudinaryParams(params = {}) {
  if (!env.CLOUDINARY_API_SECRET) throw new Error("CLOUDINARY_API_SECRET missing");
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const toSign = sorted + env.CLOUDINARY_API_SECRET;
  const signature = crypto.createHash("sha1").update(toSign).digest("hex");
  return {
    signature,
    api_key: env.CLOUDINARY_API_KEY,
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
  };
}

module.exports = { signCloudinaryParams };
