const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { config } = require("../config");
const { webhookUrl } = require("../bot/telegram");
const { getDomains, getEmail } = require("../services/heroSms");
const {
  findUserByToken,
  getOrCreateWebUser,
  saveOrder,
  listOrders,
  getOrderById,
} = require("../services/mailStore");
const { handleWebhookPayload } = require("../services/pollWorker");
const { getKeepAliveStatus } = require("../workers/keepAlive");
const {
  getWalletInfo,
  createTopup,
  handleBillplzCallback,
  isAdmin,
  adminApprovePayment,
  adminRejectPayment,
  listPendingManualPayments,
} = require("../services/payments");
const { listTransactions } = require("../services/gems");
const {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
} = require("../services/orderService");
const { getExchangeInfo } = require("../services/exchangeRate");
const { validateInitData } = require("../services/telegramWebApp");
const { getOrCreateTelegramUser } = require("../services/mailStore");

function createWebApp() {
  const app = express();

  // Trust Render's proxy (required for rate limiting behind reverse proxy)
  app.set("trust proxy", 1);

  // ── Security headers via helmet ───────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "https://telegram.org",
            "https://fonts.googleapis.com",
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'", "https://telegram.org"],
        },
      },
    }),
  );

  // ── HTTPS redirect in production ──────────────────────────────────────────
  if (config.isProduction) {
    app.use((req, res, next) => {
      if (
        req.headers["x-forwarded-proto"] !== "https" &&
        req.headers["x-forwarded-proto"]
      ) {
        return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
      }
      next();
    });
  }

  // ── CORS: only allow our own webapp URL ──────────────────────────────────
  const allowedOrigins = config.webappUrl
    ? [config.webappUrl, "https://telegram.org"]
    : ["https://telegram.org"];
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin) return cb(null, true);
        if (
          allowedOrigins.includes(origin) ||
          origin.endsWith(".telegram.org")
        ) {
          return cb(null, true);
        }
        cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    }),
  );

  // ── Body parsers ─────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, "public")));

  // ── Rate limiters ────────────────────────────────────────────────────────
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many auth attempts, please try again later." },
  });

  const orderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many order requests, please slow down." },
  });

  const topupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many top-up attempts, please try again later." },
  });

  // Apply general rate limiter to all /api and /webhook routes
  app.use(["/api", "/webhook"], generalLimiter);

  // ── Public endpoints (no auth required) ──────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      keepAlive: getKeepAliveStatus(),
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      botUsername: config.botUsername || null,
      defaultSite: config.defaultSite,
      defaultDomain: config.defaultDomain,
      webhookUrl: webhookUrl(),
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  // ── Auth endpoint (separate rate limit) ──────────────────────────────────
  app.post(
    "/api/telegram-auth",
    authLimiter,
    express.text({ type: "*/*" }),
    (req, res) => {
      const initData =
        typeof req.body === "string" ? req.body : req.body?.initData;
      const parsed = validateInitData(initData);

      if (!parsed) {
        res.status(401).json({ error: "Invalid Telegram session" });
        return;
      }

      const user = getOrCreateTelegramUser(parsed.user.id);
      res.json({
        token: user.accessToken,
        source: "telegram",
        telegramId: parsed.user.id,
        firstName: parsed.user.first_name || null,
      });
    },
  );

  app.get("/api/session", authLimiter, (req, res) => {
    const token = req.query.token;
    const user = token ? findUserByToken(token) : null;

    if (user) {
      res.json({
        token: user.accessToken,
        source: user.telegramId ? "telegram" : "web",
      });
      return;
    }

    const newUser = getOrCreateWebUser(null);
    res.json({ token: newUser.accessToken, source: "web" });
  });

  // ── Webhooks (external callbacks) ────────────────────────────────────────
  app.post("/webhook/hero-sms", async (req, res) => {
    if (config.webhookSecret) {
      const secret = req.headers["x-webhook-secret"] || req.query.secret;
      if (secret !== config.webhookSecret) {
        res.status(401).json({ ok: false, error: "invalid_secret" });
        return;
      }
    }

    try {
      const result = await handleWebhookPayload(req.body);
      res.json(result);
    } catch (err) {
      console.error("Webhook error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/webhook/billplz", async (req, res) => {
    try {
      const result = await handleBillplzCallback({ ...req.body, ...req.query });
      res.json(result);
    } catch (err) {
      console.error("Billplz webhook error:", err);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ── Auth middleware for protected API routes ─────────────────────────────
  // Only checks Authorization header — no token from query params
  app.use("/api", (req, res, next) => {
    // Skip public endpoints already handled above
    if (
      req.path === "/health" ||
      req.path === "/config" ||
      req.path === "/telegram-auth" ||
      req.path === "/session"
    ) {
      return next();
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (!token) {
      res.status(401).json({
        error: "Missing access token (use Authorization: Bearer <token>)",
      });
      return;
    }

    const user = findUserByToken(token);
    if (!user) {
      res.status(401).json({ error: "Invalid access token" });
      return;
    }

    req.user = user;
    next();
  });

  // ── Protected API routes ─────────────────────────────────────────────────
  app.get("/api/wallet", async (req, res) => {
    try {
      const wallet = await getWalletInfo(req.user.id);
      res.json(wallet);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/wallet/transactions", (req, res) => {
    res.json({ transactions: listTransactions(req.user.id, { limit: 50 }) });
  });

  app.get("/api/exchange", async (_req, res) => {
    try {
      res.json(await getExchangeInfo());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/topup", topupLimiter, async (req, res) => {
    try {
      const { method, packageId, amountMyr } = req.body || {};
      const result = await createTopup(req.user.id, {
        method,
        packageId,
        amountMyr,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/domains", async (_req, res) => {
    try {
      const domains = await getDomains();
      const list = Array.isArray(domains) ? domains : [];
      const withGems = await Promise.all(
        list.map(async (d) => {
          const name = d.name || d.domain;
          const { costGems } = await estimateOrderCost(name);
          return { ...d, costGems };
        }),
      );
      res.json({ domains: withGems });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/orders", (req, res) => {
    res.json({ orders: listOrders(req.user.id, { limit: 100 }) });
  });

  app.get("/api/orders/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const order = getOrderById(id, req.user.id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = saveOrder(req.user.id, remote);
      res.json({ order: updated });
    } catch {
      res.json({ order });
    }
  });

  app.post("/api/orders", orderLimiter, async (req, res) => {
    try {
      const { site, domain } =
        await require("../services/orderService").resolveOrderDomain(
          req.body?.domain || "",
          req.body?.site || "",
        );
      const { order, gemsCharged } = await placeOrder(
        req.user.id,
        site,
        domain,
      );
      res.status(201).json({ order, gemsCharged });
    } catch (err) {
      if (err.code === "INSUFFICIENT_GEMS") {
        res.status(402).json({
          error: err.message,
          requiredGems: err.requiredGems,
          balance: err.balance,
        });
        return;
      }
      res.status(502).json({ error: err.message });
    }
  });

  app.delete("/api/orders/:id", orderLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const order = getOrderById(id, req.user.id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    try {
      await cancelOrderWithRefund(req.user.id, order);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Admin endpoints (protected + admin-only) ─────────────────────────────
  function isAdminUser(req) {
    const tid = req.user?.telegramId;
    return tid && config.adminTelegramIds.includes(String(tid));
  }

  app.get("/api/admin/pending-payments", async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    try {
      const pending = await listPendingManualPayments();
      res.json({ payments: pending });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/approve-payment", async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    const { paymentId } = req.body || {};
    if (!paymentId) {
      res.status(400).json({ error: "paymentId required" });
      return;
    }
    try {
      const result = await adminApprovePayment(paymentId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/admin/reject-payment", async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    const { paymentId } = req.body || {};
    if (!paymentId) {
      res.status(400).json({ error: "paymentId required" });
      return;
    }
    try {
      const result = await adminRejectPayment(paymentId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── SPA fallback: serve index.html for all non-API routes ────────────────
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

module.exports = { createWebApp };
