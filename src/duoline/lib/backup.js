const crypto = require("crypto");
const { User, Message } = require("../models");
const { getMediaKey } = require("../routes/media");
const { isS3Configured, putObject } = require("./storage");

// Sauvegarde automatique de la conversation (comptes + tous les messages) :
// exportée en JSON, chiffrée avec la clé des médias (AES-256-GCM), puis
// déposée dans le stockage objet. Le bucket étant lisible publiquement, le
// chiffrement est ce qui garde le contenu privé. Un fichier par jour de la
// semaine, écrasé chaque semaine => les 7 derniers jours sont conservés
// sans avoir à lister ni supprimer quoi que ce soit.
const EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

async function runBackup() {
  if (!isS3Configured) return null;

  const users = await User.findAll({ raw: true });
  const messages = await Message.findAll({ raw: true, order: [["id", "ASC"]] });
  const payload = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), users, messages }));

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(getMediaKey(), "base64"), iv);
  const body = Buffer.concat([iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

  const url = await putObject(`backups/duoline-${new Date().getDay()}.enc`, body);
  console.log(`[duoline] sauvegarde OK (${messages.length} messages, ${Math.round(body.length / 1024)} Ko)`);
  return url;
}

function startBackups() {
  if (!isS3Configured) return;
  const run = () => runBackup().catch((err) => console.error("[duoline] échec sauvegarde:", err.message));
  setTimeout(run, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(run, EVERY_MS).unref?.();
}

module.exports = { runBackup, startBackups };
