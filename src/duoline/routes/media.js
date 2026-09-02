const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Transform } = require("stream");
const { Message, User } = require("../models");
const { requireAuth } = require("../middleware/auth");
const { notifyOthers } = require("../lib/push");
const { isPartnerOnline } = require("../lib/presence");
const { ROOM } = require("../config/constants");
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
        cb(null, { path: url, size, kind });
      })
      .catch(cb);
  }

  _removeFile(_req, _file, cb) {
    cb(null);
  }
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
        deliveredAt: isPartnerOnline(io, ROOM, req.user.id) ? new Date() : null,
      });

      const full = await Message.findByPk(message.id, {
        include: [{ model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] }],
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

  return router;
}

module.exports = { createMediaRouter, uploadsDir };
