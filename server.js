// server.js
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const http = require("http");
const path = require("path");

// ✅ dotenv silencieux (supprime les logs "[dotenv] Injection...")
require("dotenv").config({ quiet: true });

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
const events = require("./src/routes/events");
const productRatingsRouter = require("./src/routes/productRatings");

// ✅ AI Ads routes
const googleAiAdsRoutes = require("./src/routes/google_ai_ads");
let metaAiAdsRoutes = null;
try {
  metaAiAdsRoutes = require("./src/routes/meta_ai_ads");
} catch {
  // optionnel si pas encore créé
}

// ✅ (optionnel) env-check admin-only
let authRequired, isAdmin;
try {
  ({ authRequired, isAdmin } = require("./src/middlewares/auth"));
} catch {
  // si jamais le chemin change, on ignore
}

/* =========================
 * ✅ SAFE env log (sans secrets)
 * ========================= */
function yn(v) {
  return v ? "OK" : "MISSING";
}

console.log("[ENV] NODE_ENV =", env.NODE_ENV);
console.log("[ENV] PORT =", env.PORT);
console.log("[ENV] CORS_ORIGINS =", env.CORS_ORIGINS || "*");

// AI / OPENAI
console.log("[ENV] DUUMINI_AI_MODE =", env.DUUMINI_AI_MODE || "SAFE");
console.log("[ENV] OPENAI_API_KEY =", yn(env.OPENAI_API_KEY));
console.log("[ENV] OPENAI_MODEL =", env.OPENAI_MODEL || "(default)");

// META ADS
console.log("[ENV] META_AD_ACCOUNT_ID =", yn(env.META_AD_ACCOUNT_ID));
console.log("[ENV] META_AD_ACCESS_TOKEN =", yn(env.META_AD_ACCESS_TOKEN));
console.log("[ENV] META_PAGE_ID =", yn(env.META_PAGE_ID));
console.log("[ENV] META_DEFAULT_ADSET_ID =", yn(env.META_DEFAULT_ADSET_ID));

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
      if (corsOrigins === true) return cb(null, true);
      if (!origin) return cb(null, true);
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
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
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
 * ✅ Admin env-check (optionnel)
 * ========================= */
if (authRequired && isAdmin) {
  app.get("/api/admin/env-check", authRequired, isAdmin, (_req, res) => {
    return res.json({
      ok: true,
      ai: {
        DUUMINI_AI_MODE: env.DUUMINI_AI_MODE || "SAFE",
        OPENAI_API_KEY: !!env.OPENAI_API_KEY,
        OPENAI_MODEL: env.OPENAI_MODEL || null,
      },
      meta: {
        META_AD_ACCOUNT_ID: !!env.META_AD_ACCOUNT_ID,
        META_AD_ACCESS_TOKEN: !!env.META_AD_ACCESS_TOKEN,
        META_PAGE_ID: !!env.META_PAGE_ID,
        META_DEFAULT_ADSET_ID: !!env.META_DEFAULT_ADSET_ID,
        META_PIXEL_ID: !!env.META_PIXEL_ID,
        META_BUSINESS_ID: !!env.META_BUSINESS_ID,
        META_APP_ID: !!env.META_APP_ID,
      },
    });
  });
}

/* =========================
 * API routes
 * ========================= */
app.use("/api/auth", auth);
app.use("/api/auth", otpRoutes);
app.use("/api/user", users);
app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);
app.use("/api/products", products);
app.use("/api/orders", orders);

// ✅ Route de partage avec meta OG
if (products.shareRouter) {
  app.use("/share", products.shareRouter);
}

app.use("/api/uploads", uploads);
app.use("/api/devices", devices);
app.use("/api/events", events);
app.use("/api/products", productRatingsRouter);

/* =========================
 * ✅ AI ADS ROUTES (IMPORTANT: AVANT notFound/errorHandler)
 * ========================= */
app.use("/api/ads", googleAiAdsRoutes);
if (metaAiAdsRoutes) {
  app.use("/api/ads", metaAiAdsRoutes);
}

/* =========================
 * 404 + Error handler (TOUJOURS À LA FIN)
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
