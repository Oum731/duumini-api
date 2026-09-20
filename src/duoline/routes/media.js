const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Transform, Readable } = require("stream");
const crypto = require("crypto");
const { Message, User, messageInclude, resolveReplyId } = require("../models");
const { requireAuth } = require("../middleware/auth");
const { notifyOthers } = require("../lib/push");
const { isPartnerOnline } = require("../lib/presence");
const { ROOM } = require("../config/constants");
const { env } = require("../config/env");
const { isS3Configured, putObject } = require("../lib/storage");
const { isCloudinaryConfigured, uploadFromStream, transformedUrl, warmUrl } = require("../lib/cloudinary");

const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// 95 Mo : reste sous la limite de 100 Mo/fichier du plan Cloudinary Free
// utilisé ici (au-delà, Cloudinary refuserait de toute façon).
const MAX_FILE_SIZE = 95 * 1024 * 1024;

function typeFromMime(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

// Storage multer "streaming" : les octets reçus du client sont renvoyés en
// direct vers Cloudinary (ou écrits sur disque en dev) au fur et à mesure,
// au lieu d'être entièrement bufferisés en mémoire avant de repartir —
// nettement plus rapide pour les vidéos, et ne charge plus toute la RAM du
// serveur avec le fichier.
class StreamingStorage {
  _handleFile(req, file, cb) {
    const kind = typeFromMime(file.mimetype);

    // Transform "passe-plat" qui compte les octets au passage — on ne peut
    // pas juste écouter "data" sur file.stream directement : ça basculerait
    // le flux en mode "flowing" avant que .pipe() soit branché, et on
    // perdrait les tout premiers octets.
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        done(null, chunk);
      },
    });
    file.stream.on("error", cb);
    const source = file.stream.pipe(counter);

    if (!isCloudinaryConfigured) {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const filename = `${unique}${path.extname(file.originalname || "")}`;
      const ws = fs.createWriteStream(path.join(uploadsDir, filename));
      source.pipe(ws);
      ws.on("error", cb);
      ws.on("finish", () => cb(null, { path: `/duoline/uploads/${filename}`, size, kind }));
      return;
    }

    // Les photos iPhone sont souvent en HEIC — conversion en jpg à
    // l'upload, rapide. Les vidéos, elles, ne sont JAMAIS converties
    // pendant l'upload : Cloudinary refuse de le faire en synchrone sur un
    // fichier un peu gros ("too large to process synchronously"). On les
    // stocke telles quelles et on demande la conversion mp4 à la demande.
    const options =
      kind === "image"
        ? { resource_type: "image", format: "jpg" }
        : kind === "video"
        ? { resource_type: "video" }
        : { resource_type: "auto" };

    uploadFromStream(source, options)
      .then((result) => {
        let url = result.secure_url;
        if (kind === "video") {
          url = transformedUrl(result.public_id, { resource_type: "video", format: "mp4" });
          warmUrl(url); // lance la conversion tout de suite plutôt que d'attendre un 1er viewer
        }
        if (kind === "audio") {
          // Les vocaux enregistrés en webm ne se lisent pas sur iPhone :
          // on les sert en mp3 (conversion à la demande), préchauffée ici.
          warmUrl(url.replace(/\.[a-z0-9]+$/i, ".mp3"));
        }
        cb(null, { path: url, size, kind });
      })
      .catch(cb);
  }

  _removeFile(_req, _file, cb) {
    cb(null);
  }
}


// ---------------------------------------------------------------------------
// Médias chiffrés : le navigateur chiffre (AES-256-GCM) et découpe le fichier
// en morceaux de 8 Mo avant envoi. Cloudinary ne reçoit que du binaire opaque
// stocké en "raw" — il ne peut ni l'analyser ni le classer.
// ---------------------------------------------------------------------------
const PIECE_MAX = 9 * 1024 * 1024; // 8 Mo + IV + tag, sous la limite raw de 10 Mo

function getMediaKey() {
  const raw = env.mediaKey;
  if (raw) return raw;
  return crypto.createHash("sha256").update(`${env.jwtSecret}:duoline-media`).digest("base64");
}

const pieceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PIECE_MAX } });

async function storePiece(buffer) {
  if (isS3Configured) {
    return putObject(`duoline/${crypto.randomBytes(16).toString("hex")}`, buffer);
  }
  if (!isCloudinaryConfigured) {
    const filename = `enc-${Date.now()}-${Math.round(Math.random() * 1e9)}.bin`;
    await fs.promises.writeFile(path.join(uploadsDir, filename), buffer);
    return `/uploads/${filename}`;
  }
  const result = await uploadFromStream(Readable.from(buffer), { resource_type: "raw" });
  return result.secure_url;
}

const upload = multer({ storage: new StreamingStorage(), limits: { fileSize: MAX_FILE_SIZE } });

// La factory reçoit le namespace socket.io "/duoline" pour diffuser le
// nouveau message en temps réel aux deux appareils connectés.
function createMediaRouter(io) {
  const router = Router();

  // Multer est appelé "à la main" (plutôt qu'en middleware direct) pour
  // pouvoir renvoyer un message clair au client si le fichier est trop
  // volumineux, au lieu d'un 500 générique après une longue attente.
  router.post(
    "/upload",
    requireAuth,
    (req, res, next) => {
      upload.single("file")(req, res, (err) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res
              .status(413)
              .json({ error: `Fichier trop volumineux (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} Mo)` });
          }
          console.error("[duoline] Erreur upload:", err.message);
          return res.status(400).json({ error: "Échec de l'upload" });
        }
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu" });

      const duration = req.body?.duration ? Math.round(Number(req.body.duration)) : null;

      const message = await Message.create({
        senderId: req.user.id,
        type: req.file.kind,
        content: req.file.path,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        duration: Number.isFinite(duration) ? duration : null,
        replyToId: await resolveReplyId(req.body?.replyToId),
        deliveredAt: isPartnerOnline(io, ROOM, req.user.id) ? new Date() : null,
      });

      const full = await Message.findByPk(message.id, {
        include: messageInclude(),
      });

      io.to(ROOM).emit("message:new", full);

      const labels = { image: "a envoyé une photo 📷", video: "a envoyé une vidéo 🎬", audio: "a envoyé un audio 🎤", file: "a envoyé un fichier 📎" };
      notifyOthers(req.user.id, {
        title: req.user.name,
        body: labels[full.type] || "a envoyé un fichier",
        tag: "message",
        url: "/chat",
      });

      res.status(201).json(full);
    }
  );

  router.get("/key", requireAuth, (_req, res) => {
    res.json({ key: getMediaKey() });
  });

  router.post(
    "/piece",
    requireAuth,
    (req, res, next) => {
      pieceUpload.single("file")(req, res, (err) => {
        if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Morceau refusé" });
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu" });
      try {
        res.status(201).json({ url: await storePiece(req.file.buffer) });
      } catch (err) {
        console.error("Erreur upload morceau chiffré:", err.message);
        res.status(502).json({ error: "Échec de l'upload" });
      }
    }
  );

  // Crée le message une fois tous les morceaux envoyés.
  router.post("/encrypted", requireAuth, async (req, res) => {
    const { urls, type, mimeType, fileName, fileSize, duration } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 16 || !urls.every((u) => typeof u === "string")) {
      return res.status(400).json({ error: "Morceaux invalides" });
    }
    if (type !== "image" && type !== "video") return res.status(400).json({ error: "Type invalide" });

    const seconds = duration ? Math.round(Number(duration)) : null;
    const message = await Message.create({
      senderId: req.user.id,
      type,
      content: JSON.stringify(urls),
      encrypted: true,
      fileName: typeof fileName === "string" ? fileName.slice(0, 250) : null,
      fileSize: Number.isFinite(Number(fileSize)) ? Number(fileSize) : null,
      mimeType: typeof mimeType === "string" ? mimeType.slice(0, 100) : null,
      duration: Number.isFinite(seconds) ? seconds : null,
      replyToId: await resolveReplyId(req.body?.replyToId),
      deliveredAt: isPartnerOnline(io, ROOM, req.user.id) ? new Date() : null,
    });

    const full = await Message.findByPk(message.id, {
      include: messageInclude(),
    });
    io.to(ROOM).emit("message:new", full);

    notifyOthers(req.user.id, {
      title: req.user.name,
      body: type === "video" ? "a envoyé une vidéo 🎬" : "a envoyé une photo 📷",
      tag: "message",
      url: "/chat",
    });

    res.status(201).json(full);
  });

  return router;
}

module.exports = { createMediaRouter, uploadsDir, getMediaKey };
