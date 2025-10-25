const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const http = require("http");
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

// App
const app = express();
const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? true
    : env.CORS_ORIGINS.split(",").map((s) => s.trim());

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));
app.use("/media", express.static("media")); // si tu fais du local-file

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use("/api/auth", auth);
app.use("/api/users", users);
app.use("/api/shops", shops);
app.use("/api/categories", categories);
app.use("/api/shop-categories", shopCategories);
app.use("/api/products", products);
app.use("/api/orders", orders);
app.use("/api/uploads", uploads);
app.use("/api/devices", devices);

app.use(notFound);
app.use(errorHandler);

app.get("/", (_req, res) => res.json({ ok: true, service: "duumini-api" }));
app.head("/", (_req, res) => res.status(200).end());
// Socket + Worker
const server = http.createServer(app);
const { attachSocket } = require("./src/ws");
const io = attachSocket(server);
const { startNotificationWorker } = require("./src/workers/notificationWorker");
startNotificationWorker(io);

server.listen(env.PORT, '0.0.0.0', () => console.log(`API listening on :${env.PORT}`));
