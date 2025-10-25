const { io } = require("socket.io-client");

const BASE  = process.env.BASE || "http://127.0.0.1:10000";
const TOKEN = process.env.ACCESS_TOKEN || null;
const SHOP  = Number(process.env.SHOP_ID || 0);

const socket = io(BASE, {
  transports: ["websocket"],
  reconnectionAttempts: 5,
  auth: TOKEN ? { token: TOKEN } : {},
  query: TOKEN ? { token: TOKEN } : {},
});

socket.on("connect", () => {
  console.log("[WS] connected:", socket.id, "->", BASE);
  // Si votre backend exige un join explicite aux rooms boutique, décommentez:
  // if (SHOP) socket.emit("shops:join", { shop_ids: [SHOP] });
});

socket.on("connect_error", (err) => console.error("[WS] connect_error:", err.message));
socket.on("disconnect", (reason) => console.log("[WS] disconnected:", reason));

// Log TOUT
socket.onAny((event, ...args) => {
  const data = args.length > 1 ? args : args[0];
  console.log(`[WS EVENT] ${event}:`, JSON.stringify(data, null, 2));
});

// Ping facultatif si un handler existe côté serveur
setTimeout(() => { try { socket.emit("ping", { ts: Date.now() }); } catch {} }, 1500);
