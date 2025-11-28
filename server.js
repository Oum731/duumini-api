// server.js
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const http = require("http");
const path = require("path");
require("dotenv").config();

const { env } = require("./src/lib/env");
const { notFound, errorHandler } = require("./src/utils/errors");

// Routers
const auth = require("./src/routes/auth");
const users = require("./src/routes/users");
const shops = require("./src/routes/shops");
const categories = require("./src/routes/categories");
const shopCategories = require("./src/routes/shopCategories");
const products = require("./src/routes/products");
const orders = require("./src/routes/orders");
const uploads = require("./src/routes/uploads");
const devices = require("./src/routes/devices");
const otpRoutes = require("./src/routes/otp");
const events = require("./src/routes/events"); // ✅ SSE événements temps réel
const productRatingsRouter = require("./src/routes/productRatings");

const app = express();
app.set("trust proxy", 1);

/* =========================
 * CORS (Express 5 compatible)
 * ========================= */
const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? true
    : (env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (corsOrigins === true) return cb(null, true); // autorise tout
      if (!origin) return cb(null, true); // Postman/SSR
      if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("CORS not allowed for origin: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "x-access-token",
      // ✅ ajoute les headers que le navigateur envoie automatiquement
      "Cache-Control",
      "Pragma",
    ],
    exposedHeaders: ["Content-Type", "Content-Length"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  })
);

// ✅ Handler OPTIONS universel (préflight)
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();

  const origin = req.headers.origin || "";
  if (corsOrigins === true) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "x-access-token",
      "Cache-Control",
      "Pragma",
    ].join(", ")
  );
  return res.sendStatus(204);
});

/* =========================
 * Body parsers & middlewares
 * ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

/* =========================
 * Static files
 * ========================= */
app.use("/media", express.static("media"));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));

/* =========================
 * Healthcheck
 * ========================= */
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, pid: process.pid, uptime: process.uptime() })
);

/* =========================
 * Root
 * ========================= */
app.get("/", (_req, res) => res.json({ ok: true, service: "duumini-api" }));
app.head("/", (_req, res) => res.status(200).end());

/* =========================
 * API routes
 * ========================= */
app.use("/api/auth", auth);
app.use("/api/auth", otpRoutes);       // /api/auth/*
app.use("/api/user", users);           // /api/user/me
app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);
app.use("/api/products", products);
app.use("/api/orders", orders);

// ✅ Route de partage avec meta OG
if (products.shareRouter) {
  app.use("/share", products.shareRouter); // /share/product/:id
}

app.use("/api/uploads", uploads);
app.use("/api/devices", devices);
app.use("/api/events", events);        // ✅ flux SSE: /api/events/stream
app.use("/api/products", productRatingsRouter);

/* =========================
 * 404 + Error handler
 * ========================= */
app.use(notFound);
app.use(errorHandler);

/* =========================
 * Socket + Worker
 * ========================= */
const server = http.createServer(app);
const { attachSocket } = require("./src/ws");
const io = attachSocket(server);
const { startNotificationWorker } = require("./src/workers/notificationWorker");
startNotificationWorker(io);

/* =========================
 * Start
 * ========================= */
server.listen(env.PORT, "0.0.0.0", () =>
  console.log(`API listening on :${env.PORT}`)
);
