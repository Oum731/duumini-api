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

// En mémoire : soit envoyé à Cloudinary, soit écrit sur disque (fallback,
// uniquement utile si jamais Cloudinary n'était pas configuré côté hôte).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function storeFile(file) {
  if (isCloudinaryConfigured) {
    const result = await uploadBuffer(file.buffer, { resource_type: "auto" });
    return result.secure_url;
  }

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const filename = `${unique}${path.extname(file.originalname)}`;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
  return `/duoline/uploads/${filename}`;
}

function typeFromMime(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

// La factory reçoit le namespace socket.io "/duoline" pour diffuser le
// nouveau message en temps réel aux deux appareils connectés.
function createMediaRouter(io) {
  const router = Router();

  router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu" });

    const duration = req.body?.duration ? Math.round(Number(req.body.duration)) : null;
    const fileUrl = await storeFile(req.file);

    const message = await Message.create({
      senderId: req.user.id,
      type: typeFromMime(req.file.mimetype),
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
