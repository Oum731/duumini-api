const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Message, User } = require("../models");
const { requireAuth } = require("../middleware/auth");
const { notifyOthers } = require("../lib/push");
const { isPartnerOnline } = require("../lib/presence");
const { ROOM } = require("../config/constants");
const { isCloudinaryConfigured, uploadBuffer } = require("../lib/cloudinary");

const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// 95 Mo : reste sous la limite de 100 Mo/fichier du plan Cloudinary Free
// utilisé ici (au-delà, Cloudinary refuserait de toute façon). Les vraies
// vidéos de téléphone (quelques dizaines de Mo) passent large.
const MAX_FILE_SIZE = 95 * 1024 * 1024;

// En mémoire : soit envoyé à Cloudinary, soit écrit sur disque (fallback,
// uniquement utile si jamais Cloudinary n'était pas configuré côté hôte).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

function typeFromMime(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

async function storeFile(file, kind) {
  if (isCloudinaryConfigured) {
    // Les photos iPhone sont souvent en HEIC et les vidéos en HEVC/.mov —
    // illisibles par <img>/<video> dans la plupart des navigateurs. On
    // force la conversion vers un format lisible partout à l'upload.
    const options = { resource_type: "auto" };
    if (kind === "image") options.format = "jpg";
    if (kind === "video") options.format = "mp4";

    const result = await uploadBuffer(file.buffer, options);
    return result.secure_url;
  }

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const filename = `${unique}${path.extname(file.originalname)}`;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
  return `/duoline/uploads/${filename}`;
}

// La factory reçoit le namespace socket.io "/duoline" pour diffuser le
// nouveau message en temps réel aux deux appareils connectés.
function createMediaRouter(io) {
  const router = Router();

  // Multer est appelé "à la main" (plutôt qu'en middleware direct) pour
  // pouvoir renvoyer un message clair au client si le fichier est trop
  // volumineux, au lieu d'un 500 générique après une longue attente.
  router.post("/upload", requireAuth, (req, res, next) => {
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
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu" });

    const duration = req.body?.duration ? Math.round(Number(req.body.duration)) : null;
    const kind = typeFromMime(req.file.mimetype);
    const fileUrl = await storeFile(req.file, kind);

    const message = await Message.create({
      senderId: req.user.id,
      type: kind,
      content: fileUrl,
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
  });

  return router;
}

module.exports = { createMediaRouter, uploadsDir };
