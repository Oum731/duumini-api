const { Server } = require("socket.io");
const { verifyAccess } = require("../utils/jwt");
const { env } = require("../lib/env");

function parseCorsOrigins(input) {
  if (!input || input === "*") return true;
  return String(input)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let ioRef = null;

function attachSocket(server) {
  const io = new Server(server, { cors: { origin: parseCorsOrigins(env.CORS_ORIGINS) } });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token) return next(new Error("Missing token"));
      const payload = verifyAccess(token);
      socket.user = { id: payload.id, role: payload.role };
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userRoom = `user:${socket.user.id}`;
    socket.join(userRoom);
    socket.emit("welcome", { ok: true, room: userRoom });

    socket.on("ping", (d) => socket.emit("pong", d));

    socket.on("shops:subscribe", (ids = []) => {
      const shopIds = Array.isArray(ids) ? ids : [];
      shopIds.forEach((id) => socket.join(`shop:${id}`));
      socket.emit("shops:subscribed", { shopIds });
    });

    socket.on("shops:unsubscribe", (ids = []) => {
      const shopIds = Array.isArray(ids) ? ids : [];
      shopIds.forEach((id) => socket.leave(`shop:${id}`));
      socket.emit("shops:unsubscribed", { shopIds });
    });
  });

  io.broadcastToUser = (userId, event, payload) => { io.to(`user:${userId}`).emit(event, payload); };
  io.broadcastToShop = (shopId, event, payload) => { io.to(`shop:${shopId}`).emit(event, payload); };

  ioRef = io;
  console.log("[WS] Socket.IO attached. CORS_ORIGINS =", env.CORS_ORIGINS || "*");
  return io;
}

function getIO() { return ioRef; }
function emitToUsers(userIds, event, payload) {
  if (!ioRef) return;
  (Array.isArray(userIds) ? userIds : [userIds]).forEach((id) => ioRef.to(`user:${id}`).emit(event, payload));
}
function emitToShops(shopIds, event, payload) {
  if (!ioRef) return;
  (Array.isArray(shopIds) ? shopIds : [shopIds]).forEach((id) => ioRef.to(`shop:${id}`).emit(event, payload));
}

module.exports = { attachSocket, getIO, emitToUsers, emitToShops };
