const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { env } = require("../config/env");
const { Message, User } = require("../models");
const { notifyOthers } = require("../lib/push");
const { isPartnerOnline } = require("../lib/presence");
const { ROOM } = require("../config/constants");

// `io` est ici le namespace socket.io "/duoline" (io.of("/duoline")), pas le
// Server racine — isolé du reste des sockets de duumini-api.
const EDIT_WINDOW_MS = 5 * 60 * 1000;

function registerSockets(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, env.jwtSecret);
      socket.user = payload;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  let activeCall = null; // { callerId, callType, connectedAt, answered }
  let ringPushTimer = null;

  function stopRingPush() {
    clearInterval(ringPushTimer);
    ringPushTimer = null;
  }

  // Un seul push ne fait qu'un "ding" ponctuel sur le téléphone (app fermée/
  // verrouillée) — on le renvoie toutes les 4s pendant ~20s pour se
  // rapprocher d'une vraie sonnerie tant que personne n'a décroché/refusé.
  function startRingPush(callerId, callerName, callType) {
    stopRingPush();
    const body = callType === "video" ? "Appel vidéo entrant 🎥" : "Appel audio entrant 📞";
    let sent = 1;
    ringPushTimer = setInterval(() => {
      if (sent >= 5) return stopRingPush();
      sent += 1;
      notifyOthers(callerId, { title: callerName, body, tag: "call", url: "/chat" });
    }, 4000);
  }

  async function logCallEnd(status) {
    if (!activeCall) return;
    const { callerId, callType, connectedAt } = activeCall;
    activeCall = null;

    const duration = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
    const message = await Message.create({
      senderId: callerId,
      type: "call",
      callType,
      callStatus: status,
      duration,
    });
    const full = await Message.findByPk(message.id, {
      include: [{ model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] }],
    });
    io.to(ROOM).emit("message:new", full);
  }

  io.on("connection", async (socket) => {
    socket.join(ROOM);
    socket.to(ROOM).emit("presence:online", { userId: socket.user.id, name: socket.user.name });

    // Un appel sonne encore et cette personne vient (re)connecter son socket
    // (ex: elle a tapé sur la notification, app relancée à froid) -> on lui
    // renvoie l'offre tout de suite, sinon elle ne recevrait jamais
    // l'événement "call:offer" (raté pendant que l'app était fermée) et ne
    // pourrait jamais décrocher.
    if (activeCall && !activeCall.answered && activeCall.callerId !== socket.user.id) {
      socket.emit("call:offer", { sdp: activeCall.sdp, callType: activeCall.callType });
    }

    const toDeliver = await Message.findAll({
      where: { senderId: { [Op.ne]: socket.user.id }, deliveredAt: null },
      attributes: ["id"],
    });
    if (toDeliver.length > 0) {
      const deliveredAt = new Date();
      const ids = toDeliver.map((m) => m.id);
      await Message.update({ deliveredAt }, { where: { id: { [Op.in]: ids } } });
      io.to(ROOM).emit("message:delivered", { ids, deliveredAt });
    }

    socket.on("message:send", async ({ content }, ack) => {
      if (!content || !content.trim()) return;

      const partnerOnline = isPartnerOnline(io, ROOM, socket.user.id);
      const message = await Message.create({
        senderId: socket.user.id,
        type: "text",
        content: content.trim(),
        deliveredAt: partnerOnline ? new Date() : null,
      });
      const full = await Message.findByPk(message.id, {
        include: [{ model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] }],
      });

      io.to(ROOM).emit("message:new", full);
      ack?.({ ok: true, id: message.id });

      // Pas le contenu du message dans la notification (confidentialité —
      // visible sur l'écran verrouillé sinon), juste qu'il y en a un.
      notifyOthers(socket.user.id, {
        title: socket.user.name,
        body: "Nouveau message 💬",
        tag: "message",
        url: "/chat",
      });
    });

    // Modification d'un message texte déjà envoyé, dans les 5 minutes.
    socket.on("message:edit", async ({ id, content }, ack) => {
      const text = (content || "").trim();
      if (!text) return ack?.({ ok: false, error: "Message vide" });

      const message = await Message.findByPk(id);
      if (!message || message.senderId !== socket.user.id || message.type !== "text") {
        return ack?.({ ok: false, error: "Modification impossible" });
      }
      if (Date.now() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS) {
        return ack?.({ ok: false, error: "Délai de modification dépassé (5 min)" });
      }

      message.content = text;
      message.editedAt = new Date();
      await message.save();

      const full = await Message.findByPk(message.id, {
        include: [{ model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] }],
      });
      io.to(ROOM).emit("message:edited", full);
      ack?.({ ok: true });
    });

    socket.on("message:read", async ({ messageIds }) => {
      if (!Array.isArray(messageIds) || messageIds.length === 0) return;

      const readAt = new Date();
      await Message.update(
        { readAt, deliveredAt: readAt },
        { where: { id: { [Op.in]: messageIds }, senderId: { [Op.ne]: socket.user.id } } }
      );

      io.to(ROOM).emit("message:read", { ids: messageIds, readAt });
    });

    socket.on("typing", ({ isTyping }) => {
      socket.to(ROOM).emit("typing", { userId: socket.user.id, isTyping: !!isTyping });
    });

    // --- Signaling WebRTC (appels audio/vidéo) ---
    socket.on("call:offer", (payload) => {
      activeCall = {
        callerId: socket.user.id,
        callType: payload.callType,
        sdp: payload.sdp,
        connectedAt: null,
        answered: false,
      };
      socket.to(ROOM).emit("call:offer", payload);
      notifyOthers(socket.user.id, {
        title: socket.user.name,
        body: payload.callType === "video" ? "Appel vidéo entrant 🎥" : "Appel audio entrant 📞",
        tag: "call",
        url: "/chat",
      });
      startRingPush(socket.user.id, socket.user.name, payload.callType);
    });
    socket.on("call:answer", (payload) => {
      stopRingPush();
      if (activeCall) {
        activeCall.connectedAt = Date.now();
        activeCall.answered = true;
      }
      socket.to(ROOM).emit("call:answer", payload);
    });
    socket.on("call:ice-candidate", (payload) => socket.to(ROOM).emit("call:ice-candidate", payload));

    socket.on("call:hangup", (payload) => {
      stopRingPush();
      socket.to(ROOM).emit("call:hangup", payload);
      logCallEnd(activeCall?.answered ? "answered" : "missed");
    });

    socket.on("call:decline", (payload) => {
      stopRingPush();
      socket.to(ROOM).emit("call:decline", payload);
      logCallEnd("declined");
    });

    socket.on("disconnect", () => {
      stopRingPush();
      socket.to(ROOM).emit("presence:offline", { userId: socket.user.id });
      logCallEnd(activeCall?.answered ? "answered" : "missed");
    });
  });
}

module.exports = { registerSockets };
