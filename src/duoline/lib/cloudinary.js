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

// Pipe un flux (ex: le flux multipart reçu du client) directement vers
// Cloudinary, sans le bufferiser en entier d'abord — le transfert
// client -> nous et notre transfert nous -> Cloudinary se chevauchent au
// lieu de se succéder, ce qui réduit nettement le temps total d'envoi.
function uploadFromStream(readable, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto", folder: "duoline", ...options },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    readable.on("error", reject);
    readable.pipe(stream);
  });
}

// URL de livraison avec transformation à la demande (générée par Cloudinary
// au premier appel puis mise en cache côté CDN — contrairement à passer
// `format` à l'upload, ça ne bloque jamais la requête d'upload elle-même).
function transformedUrl(publicId, options) {
  return cloudinary.url(publicId, { secure: true, ...options });
}

// Déclenche la conversion à la demande tout de suite après l'upload, sans
// attendre qu'un viewer la demande — met le résultat en cache CDN plus tôt.
function warmUrl(url) {
  fetch(url).catch(() => {});
}

module.exports = { isCloudinaryConfigured, uploadBuffer, uploadFromStream, transformedUrl, warmUrl };
