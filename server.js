const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const { env } = require("./src/lib/env");
const { notFound, errorHandler } = require("./src/utils/errors");

// Routers
const auth = require("./src/routes/auth");
const users = require("./src/routes/users");
const shops = require("./src/routes/shops");
const companies = require("./src/routes/companies");
const countries = require("./src/routes/countries");
const vendorApplications = require("./src/routes/vendorApplications");
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

// ✅ NEW: expenses routes
let expenses = null;
try {
  expenses = require("./src/routes/expenses");
} catch (e) {
  console.warn("[expenses] route missing:", e?.message || e);
}

let expenseCategories = null;
try {
  expenseCategories = require("./src/routes/expense_categories");
} catch (e) {
  console.warn("[expense_categories] route missing:", e?.message || e);
}

// ✅ NEW: admin users route
let adminUsers = null;
try {
  adminUsers = require("./src/routes/adminUsers");
} catch (e) {
  console.warn("[adminUsers] route missing:", e?.message || e);
}

// ✅ NEW: reports routes
let reports = null;
try {
  reports = require("./src/routes/reports");
} catch (e) {
  console.warn("[reports] route missing:", e?.message || e);
}

// ✅ NEW: Supply chain routes
let deliveryZones = null;
let supplierProducts = null;
let supplierOrders = null;

try {
  deliveryZones = require("./src/routes/delivery_zones");
} catch (e) {
  console.warn("[delivery_zones] route missing:", e?.message || e);
}

try {
  supplierProducts = require("./src/routes/supplier_products");
} catch (e) {
  console.warn("[supplier_products] route missing:", e?.message || e);
}

try {
  supplierOrders = require("./src/routes/supplier_orders");
} catch (e) {
  console.warn("[supplier_orders] route missing:", e?.message || e);
}

// ✅ NEW: Admin validation/publish for AI content (SEO-only)
let adminContentAiRoutes = null;
try {
  adminContentAiRoutes = require("./src/routes/adminContentAi");
} catch (e) {
  console.warn("[adminContentAi] route missing:", e?.message || e);
}

// (optionnel) env-check admin-only
let authRequired;
let isAdmin;

try {
  ({ authRequired, isAdmin } = require("./src/middlewares/auth"));
} catch {}

/* =========================
 * ✅ Optional middlewares (prod)
 * ========================= */
let helmet = null;
let compression = null;
let rateLimit = null;

try {
  helmet = require("helmet");
} catch {}

try {
  compression = require("compression");
} catch {}

try {
  rateLimit = require("express-rate-limit");
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

// ✅ SEO IA only
console.log("[ENV] DUUMINI_AI_MODE =", env.DUUMINI_AI_MODE || "SAFE");
console.log("[ENV] OPENAI_API_KEY =", yn(env.OPENAI_API_KEY));
console.log("[ENV] OPENAI_MODEL =", env.OPENAI_MODEL || "(default)");

// ✅ Ads intentionally disabled
console.log("[ENV] META_AD_ACCOUNT_ID =", yn(env.META_AD_ACCOUNT_ID));
console.log("[ENV] META_AD_ACCESS_TOKEN =", yn(env.META_AD_ACCESS_TOKEN));
console.log("[ENV] META_PAGE_ID =", yn(env.META_PAGE_ID));
console.log("[ENV] META_DEFAULT_ADSET_ID =", yn(env.META_DEFAULT_ADSET_ID));

/* =========================
 * ✅ APP INIT
 * ========================= */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* =========================
 * ✅ Request ID (utile pour debug)
 * ========================= */
app.use((req, res, next) => {
  const rid =
    req.headers["x-request-id"] ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"));

  req.id = String(rid);
  res.setHeader("X-Request-Id", String(rid));
  next();
});

/* =========================
 * ✅ Security headers
 * ========================= */
if (helmet) {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
}

/* =========================
 * ✅ Compression (API + static)
 * ========================= */
if (compression) {
  app.use(compression());
}

/* =========================
 * ✅ CORS (IMPORTANT: avant les routes)
 * ========================= */
const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? true
    : (env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

function isOriginAllowed(origin) {
  if (corsOrigins === true) return true;
  if (!origin) return true;

  if (Array.isArray(corsOrigins)) {
    if (corsOrigins.includes(origin)) return true;

    const lower = origin.toLowerCase();

    for (const o of corsOrigins) {
      if (o.startsWith(".") && lower.endsWith(o.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

app.use(
  cors({
    origin(origin, cb) {
      if (isOriginAllowed(origin)) return cb(null, true);
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
      "X-Request-Id",
      "x-duumini-city",
      "X-Duumini-City",
    ],
    exposedHeaders: ["Content-Type", "Content-Length", "X-Request-Id"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  })
);

/* =========================
 * ✅ Rate limit (anti spam / brute force)
 * ========================= */
if (rateLimit) {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many auth attempts" },
  });

  app.use("/api", apiLimiter);
  app.use("/api/auth", authLimiter);
}

/* =========================
 * Middlewares
 * ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

/* =========================
 * Logs
 * ========================= */
morgan.token("id", (req) => req.id || "-");

const logFormatDev =
  ":id :method :url :status :res[content-length] - :response-time ms";
const logFormatProd = ":id :method :url :status - :response-time ms";

if (env.NODE_ENV !== "production") {
  app.use(morgan(logFormatDev));
} else {
  app.use(morgan(logFormatProd));
}

/* =========================
 * Static files
 * ========================= */
app.use("/media", express.static("media", { maxAge: "7d", index: false }));

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));

/* =========================
 * Healthcheck
 * ========================= */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    pid: process.pid,
    uptime: process.uptime(),
  });
});

/* =========================
 * Root
 * ========================= */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "duumini-api" });
});

app.head("/", (_req, res) => {
  res.status(200).end();
});

/* =========================
 * API routes
 * ========================= */
app.use("/api/auth", auth);
app.use("/api/auth", otpRoutes);

app.use("/api/user", users);

if (adminUsers) {
  app.use("/api/admin/users", adminUsers);
}

app.use("/api/shops", shops);
app.use("/api/companies", companies);
app.use("/api/countries", countries);
app.use("/api/vendor-applications", vendorApplications);
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

if (expenseCategories) {
  app.use("/api/expense-categories", expenseCategories);
}

if (expenses) {
  app.use("/api/expenses", expenses);
}

if (reports) {
  app.use("/api/reports", reports);
}

if (deliveryZones) {
  app.use("/api/delivery-zones", deliveryZones);
}

if (supplierProducts) {
  app.use("/api/supplier-products", supplierProducts);
}

if (supplierOrders) {
  app.use("/api/supplier-orders", supplierOrders);
}

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
 * AI (SEO-only) + Content validation
 * ========================= */
app.use("/api/page-copy", require("./src/routes/pageCopy"));
app.use("/api/ai", aiRoutes);
app.use("/api/snapshots", require("./src/routes/snapshots"));
app.use("/api/geo", require("./src/routes/geo"));
app.use("/api/admin", require("./src/routes/adminSite"));
if (adminContentAiRoutes) {
  app.use("/api/admin", adminContentAiRoutes);
}
const affiliateMeRoutes = require("./src/routes/affiliate_me");

app.use("/api/affiliate", affiliateMeRoutes);
const affiliatesRoutes = require("./src/routes/affiliates");
app.use("/api/affiliates", affiliatesRoutes);
/* =========================
 * ✅ Crons contrôlés par env
 * ========================= */
const RUN_CRON =
  String(process.env.RUN_CRON || "").trim() ||
  (env.NODE_ENV === "production" ? "1" : "0");

console.log("[ENV] RUN_CRON =", RUN_CRON);

if (RUN_CRON === "1") {
  try {
    const { startAutoCopyCron } = require("./src/ai/autoCopyJob");
    startAutoCopyCron();
    console.log("[cron] autoCopyJob started");
  } catch (e) {
    console.warn("[cron] autoCopyJob failed to start:", e?.message || e);
  }

  try {
    const { startSalesReportsCron } = require("./src/jobs/salesReportsCron");
    startSalesReportsCron();
    console.log("[cron] salesReportsCron started");
  } catch (e) {
    console.warn("[cron] salesReportsCron failed to start:", e?.message || e);
  }
} else {
  console.log("[cron] disabled");
}

/* =========================
 * ✅ AI ADS ROUTES DISABLED
 * ========================= */
app.use("/api/ads", (_req, res) => {
  return res.status(410).json({ error: "ads_ai_disabled" });
});

/* =========================
 * 404 + Error handler
 * ========================= */
app.use(notFound);

app.use((err, req, res, next) => {
  if (err) {
    console.error("[error]", {
      id: req?.id,
      msg: err?.message,
      stack: err?.stack,
    });
  }

  return errorHandler(err, req, res, next);
});

/* =========================
 * Server + Socket + Worker
 * ========================= */
const server = http.createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000;

let io = null;

try {
  const { attachSocket } = require("./src/ws");
  io = attachSocket(server);

  try {
    const { setIO } = require("./src/services/notify");
    setIO(io);
    console.log("[notify] io injected");
  } catch (e) {
    console.warn("[notify] setIO inject failed:", e?.message || e);
  }
} catch (e) {
  console.warn("[ws] socket attach skipped:", e?.message || e);
}

/* ✅ Worker notifications contrôlé par env */
const RUN_WORKER =
  String(process.env.RUN_WORKER || "").trim() ||
  (env.NODE_ENV === "production" ? "1" : "0");

console.log("[ENV] RUN_WORKER =", RUN_WORKER);

if (RUN_WORKER === "1" && io) {
  try {
    const {
      startNotificationWorker,
    } = require("./src/workers/notificationWorker");

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

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});