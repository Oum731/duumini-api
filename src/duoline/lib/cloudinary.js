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

// URL de livraison avec transformation à la demande (générée par Cloudinary
// au premier appel puis mise en cache côté CDN — contrairement à passer
// `format` à l'upload, ça ne bloque jamais la requête d'upload elle-même).
function transformedUrl(publicId, options) {
  return cloudinary.url(publicId, { secure: true, ...options });
}

module.exports = { isCloudinaryConfigured, uploadBuffer, transformedUrl };
