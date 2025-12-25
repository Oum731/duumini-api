// server.js
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const http = require("http");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

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
const aiRoutes = require("./src/routes/ai");
const subCategories = require("./src/routes/subCategories");
const locations = require("./src/routes/locations");

// AI Ads routes
const metaCampaignRoutes = require("./src/routes/meta_campaign");
const googleCampaignRoutes = require("./src/routes/google_campaign");
const googleAiAdsRoutes = require("./src/routes/google_ai_ads");
let metaAiAdsRoutes = null;
try {
  metaAiAdsRoutes = require("./src/routes/meta_ai_ads");
} catch {}

// (optionnel) env-check admin-only
let authRequired, isAdmin;
try {
  ({ authRequired, isAdmin } = require("./src/middlewares/auth"));
} catch {}

/* =========================
 * ✅ SAFE env log (sans secrets)
 * ========================= */
function yn(v) {
  return v ? "OK" : "MISSING";
}
console.log("[ENV] NODE_ENV =", env.NODE_ENV);
console.log("[ENV] PORT =", env.PORT);
console.log("[ENV] CORS_ORIGINS =", env.CORS_ORIGINS || "*");
console.log("[ENV] DUUMINI_AI_MODE =", env.DUUMINI_AI_MODE || "SAFE");
console.log("[ENV] OPENAI_API_KEY =", yn(env.OPENAI_API_KEY));
console.log("[ENV] OPENAI_MODEL =", env.OPENAI_MODEL || "(default)");
console.log("[ENV] META_AD_ACCOUNT_ID =", yn(env.META_AD_ACCOUNT_ID));
console.log("[ENV] META_AD_ACCESS_TOKEN =", yn(env.META_AD_ACCESS_TOKEN));
console.log("[ENV] META_PAGE_ID =", yn(env.META_PAGE_ID));
console.log("[ENV] META_DEFAULT_ADSET_ID =", yn(env.META_DEFAULT_ADSET_ID));

/* =========================
 * ✅ APP INIT
 * ========================= */
const app = express();
app.set("trust proxy", 1);

/* =========================
 * ✅ CORS (clean, pas de double OPTIONS)
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

/* =========================
 * Middlewares
 * ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// logs: dev uniquement (évite de ralentir en prod)
if (env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/* =========================
 * Static files
 * ========================= */
app.use("/media", express.static("media", { maxAge: "7d", index: false }));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));

/* =========================
 * Healthcheck (rapide)
 * ========================= */
app.get("/health", (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get("/api/health", (_req, res) =>
  res.status(200).json({ ok: true, pid: process.pid, uptime: process.uptime() })
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

app.use("/api/user", users);

app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);

app.use("/api/sub-categories", subCategories);

app.use("/api/products", products);
app.use("/api/orders", orders);

app.use("/api/uploads", uploads);
app.use("/api/devices", devices);
app.use("/api/events", events);
app.use("/api/products", productRatingsRouter);

app.use("/api/locations", locations);

/* =========================
 * Partage (OG tags)
 * ========================= */
if (products && products.shareRouter) {
  app.use("/share", products.shareRouter);
} else {
  console.warn("[share] products.shareRouter missing -> /share disabled");
}

/* =========================
 * Admin env-check (optionnel)
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
 * AI (page copy + agent)
 * ========================= */
app.use("/api/page-copy", require("./src/routes/pageCopy"));
app.use("/api/ai", aiRoutes);

/* ✅ Cron auto-copy contrôlé par env */
const RUN_CRON = String(process.env.RUN_CRON || "").trim() || (env.NODE_ENV === "production" ? "1" : "0");
if (RUN_CRON === "1") {
  try {
    const { startAutoCopyCron } = require("./src/ai/autoCopyJob");
    startAutoCopyCron();
    console.log("[cron] autoCopyJob started");
  } catch (e) {
    console.warn("[cron] failed to start:", e?.message || e);
  }
}

/* =========================
 * AI ADS ROUTES
 * ========================= */
app.use("/api/ads", googleAiAdsRoutes);
if (metaAiAdsRoutes) app.use("/api/ads", metaAiAdsRoutes);
app.use("/api/ads", metaCampaignRoutes);
app.use("/api/ads", googleCampaignRoutes);

/* =========================
 * 404 + Error handler
 * ========================= */
app.use(notFound);
app.use(errorHandler);

/* =========================
 * Server + Socket + Worker
 * ========================= */
const server = http.createServer(app);

// timeouts (évite des connexions qui pendouillent)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000;

let io = null;
try {
  const { attachSocket } = require("./src/ws");
  io = attachSocket(server);
} catch (e) {
  console.warn("[ws] socket attach skipped:", e?.message || e);
}

/* ✅ Worker notifications contrôlé par env */
const RUN_WORKER = String(process.env.RUN_WORKER || "").trim() || (env.NODE_ENV === "production" ? "1" : "0");
if (RUN_WORKER === "1" && io) {
  try {
    const { startNotificationWorker } = require("./src/workers/notificationWorker");
    startNotificationWorker(io);
    console.log("[worker] notificationWorker started");
  } catch (e) {
    console.warn("[worker] failed to start:", e?.message || e);
  }
}

/* =========================
 * Start + Graceful shutdown
 * ========================= */
server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`API listening on :${env.PORT}`);
});

function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  server.close(() => {
    console.log("[shutdown] http server closed");
    process.exit(0);
  });
  // au cas où un close bloquerait
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
