const cloudinary = require("cloudinary").v2;
const { env } = require("../config/env");

// Réutilise le compte Cloudinary déjà configuré pour duumini-api (mêmes
// clés) — appeler .config() une 2e fois avec les mêmes valeurs est sans
// risque.
const isCloudinaryConfigured = Boolean(
  env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
  });
}

function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto", folder: "duoline", ...options },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

module.exports = { isCloudinaryConfigured, uploadBuffer };
