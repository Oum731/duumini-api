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

// CORS
const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? true
    : (env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins,               // true | [list]
    credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
    exposedHeaders: ["Content-Type", "Content-Length"],
  })
);
// pour certains proxys/CDN
app.options("*", cors({
  origin: corsOrigins,
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
}));


// Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// Static media
app.use("/media", express.static("media"));

// Static uploads produits
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));

// Health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, pid: process.pid, uptime: process.uptime() })
);

// Root
app.get("/", (_req, res) => res.json({ ok: true, service: "duumini-api" }));
app.head("/", (_req, res) => res.status(200).end());

// API routes
app.use("/api/auth", auth);
app.use("/api/auth", otpRoutes);          // même préfixe OK
app.use("/api/user", users);              // 🔴 singulier: /api/user/me
app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);
app.use("/api/products", products);
app.use("/api/orders", orders);
app.use("/api/uploads", uploads);
app.use("/api/devices", devices);

// 404 + Error handler (toujours APRÈS les routes)
app.use(notFound);
app.use(errorHandler);

// Socket + Worker
const server = http.createServer(app);
const { attachSocket } = require("./src/ws");
const io = attachSocket(server);
const { startNotificationWorker } = require("./src/workers/notificationWorker");
startNotificationWorker(io);

// Start
server.listen(env.PORT, "0.0.0.0", () =>
  console.log(`API listening on :${env.PORT}`)
);
