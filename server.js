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
const products = require("./src/routes/products"); // upload/multipart géré ici
const orders = require("./src/routes/orders");
const uploads = require("./src/routes/uploads");
const devices = require("./src/routes/devices");
const otpRoutes = require("./src/routes/otp");

const app = express();
app.set("trust proxy", 1); // Render/Proxy

/* =========================
 * CORS
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
      // true => renvoie l'Origin exact, compatible credentials:true
      if (corsOrigins === true) return cb(null, true);
      // autorise requêtes sans origin (ex: Postman, SSR)
      if (!origin) return cb(null, true);
      // whitelist stricte
      if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed for origin: " + origin));
    },
    credentials: true, // mets à true seulement si tu utilises les cookies/sessions
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      // "X-Access-Token", // inutile si le front ne l'envoie plus
    ],
    exposedHeaders: ["Content-Type", "Content-Length"],
    maxAge: 86400,
  })
);

// Preflight explicite (utile derrière certains proxies/CDN)
app.options(
  "*",
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      // "X-Access-Token",
    ],
    maxAge: 86400,
  })
);

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
app.use("/api/auth", otpRoutes);
app.use("/api/user", users); // /api/user/me
app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);
app.use("/api/products", products);
app.use("/api/orders", orders);
app.use("/api/uploads", uploads);
app.use("/api/devices", devices);

/* =========================
 * 404 + Error handler
 * ========================= */
app.use(notFound);
app.use(errorHandler);

/* =========================
 * Socket + Worker (optionnel)
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
