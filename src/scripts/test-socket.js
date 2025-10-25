// scripts/test-socket.js
const { io } = require("socket.io-client");

// === CONFIG ===
const BASE   = process.env.BASE || "http://127.0.0.1:10000";
// Si votre WS exige un JWT, mettez-le ici (ou passez-le via env ACCESS_TOKEN=... node scripts/test-socket.js)
const TOKEN  = process.env.ACCESS_TOKEN || null;

// Astuce: beaucoup de serveurs lisent le token sur `auth` ou `query.token`
const socket = io(BASE, {
  transports: ["websocket"],  // pas de polling en local
  reconnectionAttempts: 5,
  auth: TOKEN ? { token: TOKEN } : {},
  query: TOKEN ? { token: TOKEN } : {},
});

socket.on("connect", () => {
  console.log("[WS] connected:", socket.id);
});

socket.on("connect_error", (err) => {
  console.error("[WS] connect_error:", err.message);
});

socket.on("disconnect", (reason) => {
  console.log("[WS] disconnected:", reason);
});

// Écouter TOUS les évènements
socket.onAny((event, ...args) => {
  console.log(`[WS EVENT] ${event}:`, JSON.stringify(args[0] ?? args, null, 2));
});

// Option: envoyer un ping au backend si vous avez un handler côté serveur
setTimeout(() => {
  try { socket.emit("ping", { ts: Date.now() }); } catch {}
}, 1500);
