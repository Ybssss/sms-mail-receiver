const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { config } = require("../config");
const { webhookUrl } = require("../bot/telegram");
const { getDomains, getEmail } = require("../services/heroSms");
const {
  findUserByTelegramId,
  findUserByToken,
  getOrCreateWebUser,
  mergeWebUserBalance,
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
const {
  SmsActivateError,
  getServices: getSmsServices,
  getPrices: getSmsPrices,
  getNumber: getSmsNumber,
  getStatus: getSmsStatus,
  getAllSms: getAllSmsMessages,
  setStatus: setSmsStatus,
  getServiceName,
} = require("../services/smsActivate");
const { myrToGems } = require("../services/exchangeRate");
const { debitGems, getUserBalance } = require("../services/gems");
const { validateInitData } = require("../services/telegramWebApp");
const { getOrCreateTelegramUser } = require("../services/mailStore");
const { getDb } = require("../db/database");

async function createWebApp() {
  const app = express();

  // Trust Render's proxy (required for rate limiting behind reverse proxy)
  app.set("trust proxy", 1);

  // Restore QR images from DB on startup (overwrites static defaults)
  try {
    const { getDb } = require("../db/database");
    const db = getDb();
    const tngDoc = await db.collection("app_config").findOne({ key: "qr_tng_base64" });
    if (tngDoc?.value) {
      const fs = require("fs");
      const dir = path.join(__dirname, "public", "qr");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "qr-tng.jpg"), Buffer.from(tngDoc.value, "base64"));
    }
    const bankDoc = await db.collection("app_config").findOne({ key: "qr_bank_base64" });
    if (bankDoc?.value) {
      const fs = require("fs");
      const dir = path.join(__dirname, "public", "qr");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "qr-bank.jpg"), Buffer.from(bankDoc.value, "base64"));
    }
  } catch (e) {
    console.warn("QR restore failed:", e.message);
  }

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
          connectSrc: ["'self'", "https:", "wss:"],
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
  // Serve static files with aggressive no-cache headers so every
  // reopen fetches fresh JS/CSS (no Ctrl+Shift+R needed)
  app.use(
    express.static(path.join(__dirname, "public"), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      },
    }),
  );

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
    async (req, res) => {
      const initData =
        typeof req.body === "string" ? req.body : req.body?.initData;

      console.log("[AUTH] Telegram auth request received, initData length:", initData?.length || 0);
      if (!initData) {
        console.log("[AUTH] No initData provided");
        res.status(401).json({ error: "Missing Telegram initData" });
        return;
      }

      // Detailed pre-validation logging
      try {
        const tempParams = new URLSearchParams(initData);
        console.log("[AUTH] initData params: hash present =", !!tempParams.get("hash"),
          ", user present =", !!tempParams.get("user"),
          ", auth_date =", tempParams.get("auth_date") || "MISSING",
          ", total keys =", [...tempParams.keys()].length);
      } catch (e) {
        console.log("[AUTH] initData parse error:", e.message);
      }

      const parsed = validateInitData(initData);
      if (!parsed) {
        console.log("[AUTH] initData validation FAILED — hash mismatch or expired (bot token configured:", !!config.botToken, ")");
        res.status(401).json({ error: "Invalid Telegram session" });
        return;
      }

      console.log("[AUTH] Validated Telegram user:", parsed.user.id, "first_name:", parsed.user.first_name,
        "language_code:", parsed.user.language_code || "none");
      try {
        const user = await getOrCreateTelegramUser(parsed.user.id);
        console.log("[AUTH] User lookup done, token:", user.accessToken ? user.accessToken.substring(0, 8) + "..." : "NONE");
        res.json({
          token: user.accessToken,
          source: "telegram",
          telegramId: parsed.user.id,
          firstName: parsed.user.first_name || null,
        });
      } catch (err) {
        console.error("[AUTH] getOrCreateTelegramUser error:", err.message);
        res.status(500).json({ error: "User creation failed: " + err.message });
      }
    },
  );

  app.get("/api/session", authLimiter, async (req, res) => {
    const token = req.query.token;
    const user = token ? await findUserByToken(token) : null;

    if (user) {
      res.json({
        token: user.accessToken,
        source: user.telegramId ? "telegram" : "web",
      });
      return;
    }

    const newUser = await getOrCreateWebUser(null);
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
    req.path === "/session" ||
    req.path === "/sms-countries" ||
    req.path === "/debug/merge"
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

    findUserByToken(token)
      .then((user) => {
        if (!user) {
          res.status(401).json({ error: "Invalid access token" });
          return;
        }
        req.user = user;
        next();
      })
      .catch((err) => {
        console.error("[AUTH] Middleware findUserByToken error:", err.message);
        res.status(500).json({ error: "Auth service unavailable" });
      });
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

  app.get("/api/wallet/transactions", async (req, res) => {
    const transactions = await listTransactions(req.user.id, { limit: 50 });
    res.json({ transactions });
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

  // Payment history
  app.get("/api/payments", async (req, res) => {
    try {
      const { listPayments } = require("../services/payments/store");
      const payments = await listPayments(req.user.id, { limit: 20 });
      const mapped = payments.map((p) => ({
        id: p.id,
        provider: p.provider,
        amountMyr: p.amountMyr,
        gems: p.gems,
        status: p.status,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      }));
      res.json({ payments: mapped });
    } catch (err) {
      res.status(500).json({ error: err.message });
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

  // ── SMS Activation API routes ─────────────────────────────────
  app.get("/api/sms-countries", async (_req, res) => {
    try {
      const {
        getCountries: getSmsCountriesList,
      } = require("../services/smsActivate");
      const countries = await getSmsCountriesList();
      res.json({ countries: Array.isArray(countries) ? countries : [] });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/sms-services", async (req, res) => {
    try {
      if (!config.smsActivateEnabled) {
        res.json({ services: [], enabled: false, currentCountryId: null });
        return;
      }
      // Get ALL services (no country filter) then prices for the selected country
      const queryCountry = req.query.country || "";
      const defaultCountryId = config.smsActivateCountryId || "7";
      const countryId = queryCountry || defaultCountryId;
      const services = await getSmsServices(null); // No country filter = all services
      const prices = await getSmsPrices(null, countryId);

      // Combine services with prices
      const priceMap = {};
      if (Array.isArray(prices)) {
        prices.forEach((entry) => {
          const code = Object.keys(entry)[0];
          const data = entry[code];
          priceMap[code] = data;
        });
      }

      // Calculate gem cost from USD prices
      let gemsPerMyrVal = 10000; // fallback
      let usdMyr = config.baseUsdMyr || 4.0; // fallback
      try {
        const { gemsPerMyr } = require("../services/exchangeRate");
        usdMyr = await require("../services/exchangeRate").fetchUsdMyrRate();
        gemsPerMyrVal = gemsPerMyr(usdMyr);
      } catch {}

      const enriched = services.map((s) => {
        const priceData = priceMap[s.code] || {};
        const costUsd = priceData.cost || 0;
        const apiName = s.name || s.code;
        // Your real cost: (USD × 1.11 purchase tax) × USD/MYR × 1.06 conversion tax × (1 + markup%)
        const purchaseTax = 1.11;
        const conversionTax = 1.06;
        const costMyr = costUsd * purchaseTax * conversionTax * usdMyr * (1 + config.orderMarkupPercent / 100);
        const costGems = Math.max(
          Math.round(costMyr * gemsPerMyrVal),
          config.minOrderGems,
        );
        return {
          code: s.code,
          name: getServiceName(s.code, apiName),
          rawName: apiName,
          costUsd,
          costGems,
          stock: priceData.count || 0,
          physicalStock: priceData.physicalCount || 0,
        };
      });

      console.log(`[DEBUG] /api/sms-services returning ${enriched.length} services for country ${countryId}`);
      res.json({ services: enriched, enabled: true, currentCountryId: countryId });
    } catch (err) {
      console.error("[DEBUG] SMS services error:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.post("/api/sms/order", orderLimiter, async (req, res) => {
    try {
      const service = (req.body?.service || "").trim();
      const country = (req.body?.country || "").trim() || config.smsActivateCountryId || "7";
      if (!service) {
        res.status(400).json({ error: "service is required" });
        return;
      }

      console.log("[DEBUG] SMS order request:", {
        service,
        country,
        userId: req.user.id,
      });

      // Get SMS number with user's selected country (or default)
      const activation = await getSmsNumber(
        service,
        country,
      );

      // Calculate gem cost
      const usdMyr =
        await require("../services/exchangeRate").fetchUsdMyrRate();
      const gemsPerMyrFn = require("../services/exchangeRate").gemsPerMyr;
      const gemsPerMyrVal = gemsPerMyrFn(usdMyr);
      // Your real cost: (USD × 1.11 purchase tax) × USD/MYR × 1.06 conversion tax × (1 + markup%)
      const purchaseTax = 1.11;
      const conversionTax = 1.06;
      const costMyr = activation.cost * purchaseTax * conversionTax * usdMyr * (1 + config.orderMarkupPercent / 100);
      const costGems = Math.max(
        Math.round(costMyr * gemsPerMyrVal),
        config.minOrderGems,
      );
      const balance = await getUserBalance(req.user.id);

      if (balance < costGems) {
        res.status(402).json({
          error: `Insufficient gems: need ${costGems.toLocaleString()}, have ${balance.toLocaleString()}`,
          requiredGems: costGems,
          balance,
        });
        // Cancel the activation since user can't pay
        setSmsStatus(activation.activationId, "8").catch(() => {});
        return;
      }

      // Debit gems and return activation info
      await debitGems(
        req.user.id,
        costGems,
        "sms_activation",
        activation.activationId,
        `${service} activation`,
      );

      // Save SMS activation to DB for listing
      try {
        const db = getDb();
        await db.collection("sms_activations").insertOne({
          user_id: req.user.id,
          activation_id: activation.activationId,
          phone_number: activation.phoneNumber,
          service: service,
          service_name: getServiceName(service),
          cost_gems: costGems,
          cost_usd: activation.cost,
          status: "WAIT_CODE",
          activation_time: activation.activationEndTime || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error("[SMS] Failed to save activation to DB:", e.message);
      }

      res.status(201).json({
        activationId: activation.activationId,
        phoneNumber: activation.phoneNumber,
        costGems,
        costUsd: activation.cost,
        service,
        serviceName: getServiceName(service),
        activationTime: activation.activationTime,
        activationEndTime: activation.activationEndTime,
        canGetAnotherSms: activation.canGetAnotherSms,
        operator: activation.operator,
      });
    } catch (err) {
      console.error("[DEBUG] SMS order error:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/sms/status/:id", async (req, res) => {
    try {
      const activationId = req.params.id;
      const statusResult = await getSmsStatus(activationId);
      const messages = await getAllSmsMessages(activationId);

      // Persist received code to DB so it survives page refreshes
      if (statusResult.status === "OK" && statusResult.smsCode) {
        try {
          const db = getDb();
          await db.collection("sms_activations").updateOne(
            { activation_id: activationId },
            {
              $set: {
                status: "OK",
                sms_code: statusResult.smsCode,
                updated_at: new Date().toISOString(),
              },
            },
          );
        } catch (e) {
          console.error("[SMS] Failed to persist received code:", e.message);
        }
      }

      res.json({ ...statusResult, messages });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post("/api/sms/status/:id", async (req, res) => {
    try {
      const activationId = req.params.id;
      const status = req.body?.status || "8"; // default: cancel
      const result = await setSmsStatus(activationId, status);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // SMS activations list endpoint
  app.get("/api/sms-activations", async (req, res) => {
    try {
      const db = getDb();
      const activations = await db.collection("sms_activations")
        .find({ user_id: req.user.id })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();

      const mapped = activations.map((a) => ({
        id: a._id.toString(),
        activationId: a.activation_id,
        phoneNumber: a.phone_number,
        service: a.service,
        serviceName: a.service_name,
        costGems: a.cost_gems,
        costUsd: a.cost_usd,
        status: a.status,
        activationTime: a.activation_time,
        smsCode: a.sms_code || null,
        createdAt: a.created_at,
      }));

      res.json({ activations: mapped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/orders", async (req, res) => {
    const orders = await listOrders(req.user.id, { limit: 100 });
    res.json({ orders });
  });

  app.get("/api/orders/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const order = await getOrderById(id, req.user.id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = await saveOrder(req.user.id, remote);
      res.json({ order: updated });
    } catch {
      res.json({ order });
    }
  });

  app.post("/api/orders", orderLimiter, async (req, res) => {
    try {
      const rawSite = (req.body?.site || "").trim();
      const rawDomain = (req.body?.domain || "").trim();

      console.log("[DEBUG] POST /api/orders received:", { rawSite, rawDomain });

      // Prefer client-provided site/domain, fall back to resolveOrderDomain
      let site, domain;
      if (rawSite && rawDomain) {
        site = rawSite;
        domain = rawDomain;
      } else {
        const resolved =
          await require("../services/orderService").resolveOrderDomain(
            rawDomain || rawSite,
            rawSite,
          );
        site = resolved.site;
        domain = resolved.domain;
      }

      if (!site) {
        res.status(400).json({ error: "site is required" });
        return;
      }
      if (!domain) {
        res.status(400).json({ error: "domain is required" });
        return;
      }

      console.log("[DEBUG] Placing order:", { site, domain });

      const { order, gemsCharged } = await placeOrder(
        req.user.id,
        site,
        domain,
      );
      res.status(201).json({ order, gemsCharged });
    } catch (err) {
      console.error("[DEBUG] Order error:", err.message);
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
    const order = await getOrderById(id, req.user.id);
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

  app.get("/api/admin/check", (req, res) => {
    const tid = req.user?.telegramId;
    const isAdmin = tid && config.adminTelegramIds.includes(String(tid));
    res.json({ isAdmin });
  });

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

  app.post("/api/debug/merge", async (req, res) => {
    // Local-only helper for running the Telegram/web merge flow without a real
    // Telegram WebView initData payload. Disabled in production.
    if (config.isProduction) {
      res.status(404).json({ error: "Not available in production" });
      return;
    }

    const callerTelegramId = req.get("x-admin-telegram-id");
    if (!callerTelegramId || !config.adminTelegramIds.includes(String(callerTelegramId))) {
      res.status(403).json({ error: "Admin-only debug endpoint" });
      return;
    }

    const { telegramId } = req.body || {};
    if (!telegramId) {
      res.status(400).json({ error: "telegramId required" });
      return;
    }

    try {
      await mergeWebUserBalance(telegramId);
      const user = await findUserByTelegramId(telegramId);
      res.json({ ok: true, user });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/submit-proof", async (req, res) => {
    console.log("[DEBUG] submit-proof called, body keys:", Object.keys(req.body || {}));
    const { paymentId, proof, fileName } = req.body || {};
    if (!paymentId || !proof) {
      console.log("[DEBUG] submit-proof missing fields:", { paymentId: !!paymentId, proof: !!proof });
      res.status(400).json({ error: "paymentId and proof (base64) required" });
      return;
    }
    try {
      const { getDb } = require("../db/database");
      const db = getDb();
      const { ObjectId } = require("mongodb");
      let paymentFilter;
      try { paymentFilter = { _id: new ObjectId(String(paymentId)) }; } catch { res.status(400).json({ error: "Invalid payment ID" }); return; }
      
      const row = await db.collection("payments").findOne(paymentFilter);
      console.log("[DEBUG] submit-proof found row:", row ? `status=${row.status}, user_id=${row.user_id}` : "NONE");
      if (!row || row.user_id !== req.user.id) {
        res.status(404).json({ error: "Payment not found or access denied" });
        return;
      }

      // Save proof as file temporarily
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      const tmpFile = path.join(os.tmpdir(), `proof_${paymentId}_${Date.now()}.jpg`);
      const proofBuffer = Buffer.from(proof, "base64");
      fs.writeFileSync(tmpFile, proofBuffer);

      // Store minimal meta
      const existingMeta = typeof row.meta === "object" && row.meta !== null ? row.meta : {};
      existingMeta.proofFileName = fileName || "";
      existingMeta.proofSize = proof.length;
      existingMeta.proofSaved = true;
      await db.collection("payments").updateOne(
        { _id: row._id },
        { $set: { meta: existingMeta, status: "pending_review" } }
      );

      // Send photo to admin via Telegram
      const adminIds = config.adminTelegramIds;
      console.log("[DEBUG] submit-proof adminIds:", adminIds);
      if (adminIds && adminIds.length > 0) {
        const { bot } = require("../bot/telegram");
        console.log("[DEBUG] submit-proof bot:", bot ? "exists" : "NULL");
        if (bot) {
          const userTelegramId = req.user.telegramId || "N/A";
          const userId = req.user.id;
          const caption = [
            `📸 New payment proof!`,
            `💰 Payment #${paymentId}`,
            `👤 User ID: #usr_${userId}`,
            `📱 Telegram: ${userTelegramId}`,
            `💵 RM ${row.amount_myr} → ${row.gems} gems`,
            `📎 ${fileName || "receipt.jpg"} (${Math.round(proof.length/1024)}KB)`,
          ].join("\n");

          for (const adminId of adminIds) {
            try {
              await bot.telegram.sendPhoto(adminId, { source: tmpFile }, {
                caption,
                reply_markup: {
                  inline_keyboard: [[
                    { text: "✅ Approve", callback_data: `confirm_approve_${paymentId}` },
                    { text: "❌ Reject", callback_data: `confirm_reject_${paymentId}` },
                  ]]
                }
              });
              console.log("[DEBUG] submit-proof sent photo to admin", adminId);
            } catch (e) {
              console.error("[DEBUG] submit-proof sendPhoto failed for admin", adminId, ":", e.message);
              // Fallback: text message
              try { await bot.telegram.sendMessage(adminId, caption); } catch {}
            }
          }
        } else {
          console.error("[DEBUG] submit-proof bot is NULL — no notification sent");
        }
      }

      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      res.json({ ok: true, message: "Proof submitted for admin review" });
    } catch (err) {
      console.error("[DEBUG] submit-proof error:", err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cancel payment (user withdraw misclick) ──────────────────
  app.post("/api/cancel-payment", async (req, res) => {
    const { paymentId } = req.body || {};
    if (!paymentId) {
      res.status(400).json({ error: "paymentId required" });
      return;
    }
    console.log("[DEBUG] cancel-payment request:", { paymentId, userId: req.user.id });
    try {
      const { getDb } = require("../db/database");
      const db = getDb();
      const { ObjectId } = require("mongodb");
      let filter;
      try { filter = { _id: new ObjectId(String(paymentId)) }; } catch { res.status(400).json({ error: "Invalid payment ID" }); return; }
      const row = await db.collection("payments").findOne(filter);
      if (!row || row.user_id !== req.user.id) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }
      if (row.status !== "pending" && row.status !== "pending_review") {
        res.status(400).json({ error: `Cannot cancel payment in status: ${row.status}` });
        return;
      }
      await db.collection("payments").updateOne(filter, { $set: { status: "cancelled" } });
      console.log("[DEBUG] cancel-payment success:", paymentId);
      res.json({ ok: true, message: "Payment cancelled" });
    } catch (err) {
      console.error("[DEBUG] cancel-payment error:", err.message);
      res.status(500).json({ error: err.message });
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

  // ── Admin dashboard endpoints ───────────────────────────────
  app.get("/api/admin/dashboard", async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    try {
      const db = getDb();
      const pending = await listPendingManualPayments();
      const [blocked, totalUsers, totalOrders, totalPayments] = await Promise.all([
        db.collection("blocked_users").find().sort({ blocked_at: -1 }).limit(20).toArray(),
        db.collection("users").countDocuments(),
        db.collection("email_orders").countDocuments(),
        db.collection("payments").countDocuments({ status: "paid" }),
      ]);
      let apiBalance = null;
      try {
        const {
          getBalance: getSmsBalance,
        } = require("../services/smsActivate");
        apiBalance = await getSmsBalance();
      } catch {}
      res.json({
        pending,
        blocked,
        stats: { totalUsers, totalOrders, totalPayments },
        apiBalance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/set-qr", async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    const { type, base64 } = req.body || {};
    if (!base64 || !type) {
      res.status(400).json({ error: "Missing type or base64" });
      return;
    }
    const key = type === "tng" ? "qr_tng_base64" : "qr_bank_base64";
    const filename = type === "tng" ? "qr-tng.jpg" : "qr-bank.jpg";
    const { getDb } = require("../db/database");
    const d = getDb();
    await d.collection("app_config").updateOne(
      { key },
      { $set: { key, value: base64 } },
      { upsert: true }
    );
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "public", "qr");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, "base64"));
    res.json({ ok: true });
  });

  // ── SPA fallback with per-request cache-busting ──────────────
  // Uses Date.now() per request so Telegram WebView never caches
  const indexTemplate = require("fs").readFileSync(
    path.join(__dirname, "public", "index.html"),
    "utf-8",
  );

  app.get("*", (_req, res) => {
    const version = String(Date.now());
    const html = indexTemplate.replace(/\{\{BUILD_VERSION\}\}/g, version);
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.type("html").send(html);
  });

  return app;
}

module.exports = { createWebApp };
