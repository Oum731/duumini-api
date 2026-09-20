const crypto = require("crypto");
const { env } = require("../config/env");

// Stockage objet compatible S3 (Cloudflare R2, Backblaze B2, MinIO, AWS...)
// pour les morceaux de médias chiffrés. Signature AWS SigV4 écrite à la main :
// un seul PUT à faire, pas besoin d'embarquer tout le SDK AWS.
const cfg = env.storage;

const isS3Configured = Boolean(
  cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey && cfg.publicUrl
);

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// Renvoie la valeur du header Authorization pour une requête S3.
// `headers` : tous les en-têtes à signer (host, x-amz-date, x-amz-content-sha256...).
function signRequest({ method, canonicalPath, query = "", headers, payloadHash, region, service = "s3", accessKeyId, secretAccessKey, amzDate }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Envoie un objet et renvoie son URL publique. Les objets sont chiffrés côté
// client et nommés au hasard : l'URL publique ne révèle rien sans la clé.
async function putObject(key, buffer) {
  const base = new URL(cfg.endpoint);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const canonicalPath = `/${cfg.bucket}/${encodedKey}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = sha256Hex(buffer);

  const headers = {
    host: base.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const authorization = signRequest({
    method: "PUT",
    canonicalPath,
    headers,
    payloadHash,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    amzDate,
  });

  const res = await fetch(`${base.origin}${canonicalPath}`, {
    method: "PUT",
    headers: { ...headers, Authorization: authorization, "Content-Type": "application/octet-stream" },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`Stockage S3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return `${cfg.publicUrl.replace(/\/+$/, "")}/${encodedKey}`;
}

module.exports = { isS3Configured, signRequest, putObject };
