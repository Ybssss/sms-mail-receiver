const { Telegraf, Markup } = require("telegraf");
const { config } = require("../config");
const { getDomains, getEmail } = require("../services/heroSms");
const {
  getServices: getSmsServices,
  getPrices: getSmsPrices,
  getNumber: getSmsNumber,
  getCountries: getSmsCountries,
  getServiceName,
} = require("../services/smsActivate");
const {
  getOrCreateTelegramUser,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
} = require("../services/mailStore");
const { setNotifier } = require("../services/notifier");
const { getUserBalance, formatGems, debitGems } = require("../services/gems");
const { getExchangeInfo } = require("../services/exchangeRate");
const {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
  resolveOrderDomain,
} = require("../services/orderService");
const {
  createTopup,
  getWalletInfo,
  handleTelegramSuccessfulPayment,
  isAdmin,
  adminApprovePayment,
} = require("../services/payments");
const { listPendingManualPayments } = require("../services/payments/store");
const { buildStarsPayload } = require("../services/payments/telegramStars");
const {
  isUserBlocked,
  blockUser,
  unblockUser,
  listBlockedUsers,
  saveUserPreference,
  getUserPreferences,
} = require("../db/database");

const LANG = {
  en: {
    hi: (name) =>
      `Hi ${name}! 👋\n\nWelcome to *SMS Mail Receiver* — your one-stop service for temporary SMS and email activation.\n\n` +
      `💎 *How to pay / top up gems:*\n` +
      `1. Tap the *"➕ Top up"* button below\n` +
      `2. Enter amount (min RM 5)\n` +
      `3. Choose *TnG* or *Bank Transfer*\n` +
      `4. Transfer to the provided account/QR\n` +
      `5. Upload receipt in the Web App\n` +
      `6. Wait for admin approval (gems credited automatically)\n\n` +
      `💰 *Check your balance:*\n` +
      `• Tap *"💎 Balance"* button below\n` +
      `• Or open the Web App (balance shown at top)\n\n` +
      `📊 *Check service prices:*\n` +
      `• Open Web App → select email or SMS service\n` +
      `• Gem cost is shown next to each service\n` +
      `• Use /domains to list email domain prices\n\n` +
      `👉 Use the buttons below or open the Web App to get started!`,
    balance: (bal, rate) =>
      `💎 Balance: ${bal} gems\n📊 Rate: 1 MYR = ${rate} gems`,
    noGems: "You have no gems. Tap ➕ Top up to buy gems.",
    topup: (rate, methods) =>
      `💎 *Top up gems*\n\n` +
      `Rate: 1 MYR = ${rate} gems\n` +
      `Available methods: ${methods.map((m) => m.name).join(", ")}\n\n` +
      `📌 *How to top up:*\n` +
      `1. Tap the *"➕ Top up"* button below or use /topup\n` +
      `2. Enter amount (min RM 5)\n` +
      `3. Choose *TnG* or *Bank Transfer*\n` +
      `4. Transfer the exact amount to the provided account/QR\n` +
      `5. Upload your payment receipt in the Web App\n` +
      `6. Wait for admin approval — gems will be credited automatically\n\n` +
      `⚠️ If you need help, contact @admin.`,
    orderEmail:
      "📧 **Email Activation**\nOpen the web dashboard to browse available domains and order.",
    orderSms:
      "📱 **SMS Activation**\nOpen the web dashboard to browse SMS services, check prices, and order numbers.",
    domains: (list) =>
      `Available email domains:\n\n${list
        .slice(0, 12)
        .map((d) => `• ${d.name || d.domain} — stock ${d.count || "?"}`)
        .join(
          "\n",
        )}\n\n🌐 Open the web app for full pricing and one-tap ordering.`,
    orders: (orders) =>
      orders.length
        ? `Your active orders:\n${orders
            .slice(0, 10)
            .map((o) => formatOrder(o))
            .join("\n\n")}`
        : "No active orders.",
    orderPlaced: (order) =>
      `✅ Order placed!\n${formatOrder(order)}\n\nWatching for incoming mail...`,
    smsActivated: (name, phone, cost, id, expires) =>
      `✅ ${name} SMS Activated!\n📱 ${phone}\n💎 ${cost} gems\n⏳ Expires: ${expires}\n🆔 ${id}\n\nCheck code on dashboard.`,
    blocked: "You are blocked from using this bot.",
    help:
      `📖 *Available commands:*\n\n` +
      `🔹 /start — Show welcome & main menu\n` +
      `🔹 /balance — Check your gem balance\n` +
      `🔹 /topup — View top-up options & instructions\n` +
      `🔹 /domains — List available email domains with prices\n` +
      `🔹 /list — View your active orders\n` +
      `🔹 /web — Open the web dashboard\n` +
      `🔹 /lang — Switch language (en/zh)\n` +
      `🔹 /order <site> [domain] — Place an order directly (advanced)\n` +
      `🔹 /cancel <order_id> — Cancel an active order\n\n` +
      `🔸 *Admin commands* (admins only):\n` +
      `/approve, /reject, /revoke, /users, /user, /stats, /block, /unblock, /blocked, /reply, /setqr_tng, /setqr_bank, /balanceapi, /countries, /setcountry, /webhook, /admin`,
  },
  "zh-CN": {
    hi: (name) =>
      `你好 ${name}！👋\n\n欢迎使用 *SMS邮件接收器* — 一站式临时短信和邮箱激活服务。\n\n` +
      `💎 *如何支付/充值宝石:*\n` +
      `1. 点击下方 *"➕ 充值"* 按钮\n` +
      `2. 输入金额（最低 RM 5）\n` +
      `3. 选择 *TnG* 或 *银行转账*\n` +
      `4. 转账到提供的账户/二维码\n` +
      `5. 在网页应用中上传付款凭证\n` +
      `6. 等待管理员审核（宝石自动到账）\n\n` +
      `💰 *查看余额:*\n` +
      `• 点击下方 *"💎 余额"* 按钮\n` +
      `• 或打开网页应用（顶部显示余额）\n\n` +
      `📊 *查看价格:*\n` +
      `• 打开网页应用 → 选择邮箱或短信服务\n` +
      `• 每个服务旁边显示宝石价格\n` +
      `• 使用 /domains 查看邮箱域名价格\n\n` +
      `👉 使用下方按钮或打开网页应用开始使用！`,
    balance: (bal, rate) =>
      `💎 余额: ${bal} 宝石\n📊 汇率: 1 MYR = ${rate} 宝石`,
    noGems: "您没有宝石。请点击 ➕ 充值。",
    topup: (rate, methods) =>
      `💎 *充值宝石*\n\n` +
      `汇率: 1 MYR = ${rate} 宝石\n` +
      `可用方式: ${methods.map((m) => m.name).join(", ")}\n\n` +
      `📌 *充值步骤:*\n` +
      `1. 点击下方 *"➕ 充值"* 按钮或使用 /topup\n` +
      `2. 输入金额（最低 RM 5）\n` +
      `3. 选择 *TnG* 或 *银行转账*\n` +
      `4. 转账到提供的账户/二维码\n` +
      `5. 在网页应用中上传付款凭证\n` +
      `6. 等待管理员审核 — 宝石自动到账\n\n` +
      `⚠️ 如有问题，请联系 @admin。`,
    orderEmail: "📧 **邮箱激活**\n打开网页面板浏览可用域名并下单。",
    orderSms: "📱 **短信激活**\n打开网页面板浏览短信服务，查看价格并下单。",
    domains: (list) =>
      `可用邮箱域名：\n\n${list
        .slice(0, 12)
        .map((d) => `• ${d.name || d.domain} — 库存 ${d.count || "?"}`)
        .join("\n")}\n\n🌐 打开网页应用查看完整价格并一键下单。`,
    orders: (orders) =>
      orders.length
        ? `您的活跃订单：\n${orders
            .slice(0, 10)
            .map((o) => formatOrder(o))
            .join("\n\n")}`
        : "无活跃订单。",
    orderPlaced: (order) =>
      `✅ 下单成功！\n${formatOrder(order)}\n\n等待接收邮件...`,
    smsActivated: (name, phone, cost, id, expires) =>
      `✅ ${name} 短信已激活！\n📱 ${phone}\n💎 ${cost} 宝石\n⏳ 过期时间: ${expires}\n🆔 ${id}`,
    blocked: "您已被禁止使用此机器人。",
    help:
      `📖 *可用命令:*\n\n` +
      `🔹 /start — 显示欢迎及主菜单\n` +
      `🔹 /balance — 查询宝石余额\n` +
      `🔹 /topup — 查看充值选项及说明\n` +
      `🔹 /domains — 列出可用的邮箱域名及价格\n` +
      `🔹 /list — 查看当前活跃订单\n` +
      `🔹 /web — 打开网页控制面板\n` +
      `🔹 /lang — 切换语言 (en/zh)\n` +
      `🔹 /order <site> [domain] — 直接下单（高级）\n` +
      `🔹 /cancel <order_id> — 取消活跃订单\n\n` +
      `🔸 *管理员命令* (仅管理员):\n` +
      `/approve, /reject, /revoke, /users, /user, /stats, /block, /unblock, /blocked, /reply, /setqr_tng, /setqr_bank, /balanceapi, /countries, /setcountry, /webhook, /admin`,
  },
};

function t(userLang, key, ...args) {
  const lang = LANG[userLang] || LANG.en;
  const fn = lang[key] || LANG.en[key];
  if (typeof fn === "function") return fn(...args);
  return fn || key;
}

let userLangs = {};

function getUserLang(telegramId) {
  if (userLangs[telegramId]) return userLangs[telegramId];
  try {
    const prefs = getUserPreferences(telegramId);
    const lang = prefs.language || "en";
    userLangs[telegramId] = lang;
    return lang;
  } catch {
    return "en";
  }
}

function webAppUrl(token) {
  if (!config.webappUrl) return null;
  return `${config.webappUrl}/?token=${token}`;
}

function replyKeyboard(token, userId) {
  const appUrl = webAppUrl(token);
  const lang = getUserLang(userId);
  const isZh = lang === "zh-CN";
  const rows = [
    [isZh ? "💎 余额" : "💎 Balance", isZh ? "➕ 充值" : "➕ Top up"],
    [isZh ? "📬 活跃邮件" : "📬 Active mail", isZh ? "🛒 下单" : "🛒 Order"],
    [isZh ? "📋 域名" : "📋 Domains", isZh ? "🌐 打开应用" : "🌐 Open App"],
  ];
  if (appUrl)
    rows[2][1] = Markup.button.webApp(
      isZh ? "🌐 打开应用" : "🌐 Open App",
      appUrl,
    );
  return Markup.keyboard(rows).resize();
}

// ── Admin keyboard ─────────────────────────────────────────────
function adminReplyKeyboard(token, userId) {
  const appUrl = webAppUrl(token);
  const base = replyKeyboard(token, userId).reply_markup; // 保留用户键盘
  // 在用户键盘基础上追加一行管理员按钮
  const extraRow = [
    Markup.button.callback("📋 Pending Payments", "admin_pending"),
    Markup.button.callback("👥 Users", "admin_users"),
  ];
  const keyboard = base.keyboard ? [...base.keyboard, extraRow] : [extraRow];
  return Markup.keyboard(keyboard).resize();
}

async function findTokenForOrder(order) {
  const { getDb } = require("../db/database");
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let orderFilter;
  try {
    orderFilter = { _id: new ObjectId(String(order.id)) };
  } catch {
    orderFilter = { hero_id: order.heroId || order.id };
  }
  const eOrder = await d.collection("email_orders").findOne(orderFilter);
  if (!eOrder) return "";
  const userDoc = await d.collection("users").findOne({ _id: eOrder.user_id });
  return userDoc?.access_token || "";
}

function formatMailAlert(order, source) {
  return [
    "📨 Mail received!",
    "",
    formatOrder(order),
    "",
    `Source: ${source}`,
  ].join("\n");
}

async function formatBalance(userId, lang) {
  const wallet = await getWalletInfo(userId);
  return t(
    lang,
    "balance",
    formatGems(wallet.balance),
    wallet.exchange.gemsPerMyr.toLocaleString(),
  );
}

async function forwardToAdmins(bot, ctx) {
  if (!config.adminTelegramIds.length) return;
  const user = ctx.from;
  const msg = ctx.message;
  if (!msg || !msg.text) return;
  const replyCode =
    "usr_" +
    (user.id % 100000).toString(36) +
    "_" +
    (Date.now() % 100000).toString(36);
  const text = `📩 #${user.first_name || "User"} ${user.last_name || ""} (ID: ${user.id})\nChatID: ${user.id}\nCode: #${replyCode}\n\nMessage: ${msg.text}`;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Done Reply",
        `admin_reply_${user.id}_${replyCode}`,
      ),
    ],
    [
      Markup.button.callback("🚫 Block User", `admin_block_${user.id}`),
      Markup.button.callback("🔓 Unblock", `admin_unblock_${user.id}`),
    ],
  ]);
  for (const adminId of config.adminTelegramIds) {
    try {
      await bot.telegram.sendMessage(adminId, text, kb);
    } catch {}
  }
}

function createBot() {
  if (!config.botToken) {
    console.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }
  const bot = new Telegraf(config.botToken);

  // ── Notification handler ──────────────────────────────────────
  setNotifier(async (order, source) => {
    const { getDb } = require("../db/database");
    const d = getDb();
    const { ObjectId } = require("mongodb");
    let orderFilter;
    try {
      orderFilter = { _id: new ObjectId(String(order.id)) };
    } catch {
      orderFilter = { hero_id: order.heroId || order.id };
    }
    const eOrder = await d.collection("email_orders").findOne(orderFilter);
    if (!eOrder) return;
    const userDoc = await d
      .collection("users")
      .findOne({ _id: eOrder.user_id });
    if (!userDoc?.telegram_id) return;
    try {
      await bot.telegram.sendMessage(
        userDoc.telegram_id,
        formatMailAlert(order, source),
        { disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Notify failed:", err.message);
    }
  });

  // ── Block check middleware ────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.from && (await isUserBlocked(ctx.from.id))) {
      try {
        await ctx.reply(t(getUserLang(ctx.from.id), "blocked"));
      } catch {}
      return;
    }
    await next();
  });

  // ── Start ────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const name = ctx.from?.first_name || "there";
    const appUrl = webAppUrl(user.accessToken);
    const message = t(lang, "hi", name);

    // 检查是否为管理员
    const isAdminUser = isAdmin(ctx.from.id);

    // 构建内联键盘（Web App + 管理员额外按钮）
    const inlineButtons = [];
    if (appUrl) {
      inlineButtons.push([Markup.button.webApp("🌐 Open Dashboard", appUrl)]);
    }
    if (isAdminUser) {
      inlineButtons.push([
        Markup.button.callback("🔐 Admin Panel", "admin_panel"),
      ]);
    }
    const inlineKeyboard = inlineButtons.length
      ? Markup.inlineKeyboard(inlineButtons)
      : undefined;

    // 选择键盘：管理员使用 adminReplyKeyboard，普通用户使用原键盘
    const keyboard = isAdminUser
      ? adminReplyKeyboard(user.accessToken, user.telegramId).reply_markup
      : replyKeyboard(user.accessToken, user.telegramId).reply_markup;

    await ctx.reply(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
      ...(inlineKeyboard ? inlineKeyboard : {}),
    });
  });

  // ── Help ─────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(t(getUserLang(ctx.from?.id), "help"));
  });
  bot.hears(/^(❓ Help|帮助)$/, async (ctx) => {
    await ctx.reply(t(getUserLang(ctx.from?.id), "help"));
  });

  // ── Balance ──────────────────────────────────────────────────
  bot.hears(/^(💎 Balance|💎 余额)$/, async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const text = await formatBalance(user.id, lang);
    await ctx.reply(text, replyKeyboard(user.accessToken, user.telegramId));
  });
  bot.command("balance", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const text = await formatBalance(user.id, getUserLang(user.telegramId));
    await ctx.reply(text);
  });

  // ── Top up ───────────────────────────────────────────────────
  bot.hears(/^(➕ Top up|➕ 充值)$/, async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const wallet = await getWalletInfo(user.id);
    const text = t(
      lang,
      "topup",
      wallet.exchange.gemsPerMyr.toLocaleString(),
      wallet.methods,
    );
    await ctx.reply(text, replyKeyboard(user.accessToken, user.telegramId));
  });

  // ── Order ────────────────────────────────────────────────────
  bot.hears(/^(🛒 Order|🛒 下单)$/, async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const appUrl = webAppUrl(user.accessToken);
    const text = t(lang, "orderEmail") + "\n\n" + t(lang, "orderSms");
    const extra = appUrl
      ? Markup.inlineKeyboard([[Markup.button.webApp("🌐 Order Now", appUrl)]])
      : undefined;
    await ctx.reply(
      text,
      extra
        ? {
            ...extra,
            reply_markup: replyKeyboard(user.accessToken, user.telegramId)
              .reply_markup,
          }
        : replyKeyboard(user.accessToken, user.telegramId),
    );
  });

  // ── Active mail ──────────────────────────────────────────────
  bot.hears(/^(📬 Active mail|📬 活跃邮件)$/, async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.reply(
      t(lang, "orders", orders),
      replyKeyboard(user.accessToken, user.telegramId),
    );
  });
  bot.command("list", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.reply(t(getUserLang(user.telegramId), "orders", orders));
  });

  // ── Domains ──────────────────────────────────────────────────
  bot.hears(/^(📋 Domains|📋 域名)$/, async (ctx) => {
    const lang = getUserLang(ctx.from?.id);
    try {
      const domains = await getDomains();
      const list = Array.isArray(domains) ? domains : [];
      await ctx.reply(
        t(lang, "domains", list),
        replyKeyboard(
          getOrCreateTelegramUser(ctx.from.id).accessToken,
          ctx.from.id,
        ),
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });
  bot.command("domains", async (ctx) => {
    try {
      const domains = await getDomains();
      const list = Array.isArray(domains) ? domains : [];
      await ctx.reply(t(getUserLang(ctx.from?.id), "domains", list));
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // ── Web app ──────────────────────────────────────────────────
  bot.hears(/^(🌐 Open App|🌐 打开应用)$/, async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const appUrl = webAppUrl(user.accessToken);
    if (appUrl) {
      await ctx.reply(
        "Open your dashboard:",
        Markup.inlineKeyboard([
          [Markup.button.webApp("🌐 SMS Mail Receiver", appUrl)],
        ]),
      );
    } else {
      await ctx.reply("WEBAPP_URL not configured.");
    }
  });
  bot.command("web", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const appUrl = webAppUrl(user.accessToken);
    if (appUrl) {
      await ctx.reply(
        "Open:",
        Markup.inlineKeyboard([[Markup.button.webApp("🌐 Dashboard", appUrl)]]),
      );
    } else {
      await ctx.reply("WEBAPP_URL not set.");
    }
  });

  // ── Language switch ──────────────────────────────────────────
  bot.command("lang", async (ctx) => {
    const lang = ctx.message.text.replace(/^\/lang\s*/i, "").trim();
    if (lang === "zh" || lang === "zh-CN" || lang === "cn") {
      userLangs[ctx.from.id] = "zh-CN";
      saveUserPreference(ctx.from.id, "language", "zh-CN");
      await ctx.reply("语言已切换为中文 ✅ / Language switched to Chinese ✅");
    } else {
      userLangs[ctx.from.id] = "en";
      saveUserPreference(ctx.from.id, "language", "en");
      await ctx.reply("Language switched to English ✅");
    }
  });

  // ── Admin: forward user messages ─────────────────────────────
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || isAdmin(ctx.from.id)) {
      await next();
      return;
    }
    if (
      ctx.message?.text &&
      !ctx.message.text.startsWith("/") &&
      !ctx.message.text.match(/^(💎|➕|📬|🛒|📋|🌐|帮助)/)
    ) {
      await forwardToAdmins(bot, ctx);
    }
    await next();
  });

  // ── Admin: reply / block / unblock ───────────────────────────
  // ── Admin callback handlers ────────────────────────────────────
  bot.action("admin_panel", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only.");
      return;
    }
    // 调用 /admin 命令逻辑
    await ctx.reply("🔐 *Admin Panel*\nChoose an action:", {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("📋 Pending Payments", "admin_pending")],
        [Markup.button.callback("👥 List Users", "admin_users")],
        [Markup.button.callback("📊 Dashboard", "admin_stats")],
        [Markup.button.callback("❌ Close", "admin_close")],
      ]),
    });
  });

  bot.action("admin_pending", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    // 重新触发 /approve 命令（无参数，列出待付款）
    const d = getDb();
    const pending = await d
      .collection("payments")
      .aggregate([
        {
          $match: {
            provider: { $in: ["manual_tng", "manual_bank"] },
            status: { $in: ["pending", "pending_review"] },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "user_id",
            foreignField: "telegram_id",
            as: "u",
          },
        },
        { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
        { $sort: { _id: 1 } },
        { $limit: 20 },
      ])
      .toArray();
    if (!pending.length) {
      await ctx.reply("No pending manual payments.");
      return;
    }
    // 发送列表，每个附带批准/拒绝按钮
    for (const p of pending) {
      const id = p._id.toString();
      const caption =
        `📋 #${id.slice(-6)} · RM ${p.amount_myr} → ${formatGems(p.gems)} · ${p.provider}\n` +
        `👤 ${p.u?.telegram_id || p.user_id}` +
        (p.status === "pending_review" ? " 📎" : "");
      await ctx.reply(caption, {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Approve", `confirm_approve_${id}`),
            Markup.button.callback("❌ Reject", `confirm_reject_${id}`),
          ],
        ]),
      });
    }
  });

  bot.action("admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    // 调用 /users 命令（可复用其逻辑）
    const d = getDb();
    const users = await d
      .collection("users")
      .find()
      .sort({ created_at: -1 })
      .limit(10)
      .toArray();
    if (!users.length) {
      await ctx.reply("No users.");
      return;
    }
    const lines = users.map(
      (u, i) =>
        `#${i + 1} ID: ...${u._id.toString().slice(-6)} | 💎 ${formatGems(u.gems_balance || 0)} | ${u.telegram_id ? "TG:" + u.telegram_id : "Web"}`,
    );
    await ctx.reply(`👥 Recent users:\n${lines.join("\n")}`);
  });

  bot.action("admin_stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    // 调用 /stats 逻辑（可复用）
    const d = getDb();
    const [users, orders, payments] = await Promise.all([
      d.collection("users").countDocuments(),
      d.collection("email_orders").countDocuments(),
      d.collection("payments").countDocuments({ status: "paid" }),
    ]);
    await ctx.reply(
      `📊 Stats\n👥 ${users} users\n📧 ${orders} orders\n💰 ${payments} paid`,
    );
  });

  bot.action("admin_close", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.command("block", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(
      ctx.message.text.replace(/^\/block\s*/i, "").trim(),
      10,
    );
    if (!id) {
      await ctx.reply("Usage: /block <user_id>");
      return;
    }
    blockUser(id, "Admin command", ctx.from.id);
    await ctx.reply(`User ${id} blocked ✅`);
  });

  bot.command("unblock", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(
      ctx.message.text.replace(/^\/unblock\s*/i, "").trim(),
      10,
    );
    if (!id) {
      await ctx.reply("Usage: /unblock <user_id>");
      return;
    }
    unblockUser(id);
    await ctx.reply(`User ${id} unblocked ✅`);
  });

  bot.command("blocked", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const list = listBlockedUsers();
    if (!list.length) {
      await ctx.reply("No blocked users.");
      return;
    }
    await ctx.reply(
      list
        .map(
          (b) =>
            `❌ ID: ${b.user_id} | ${b.reason || "no reason"} | ${b.blocked_at}`,
        )
        .join("\n"),
    );
  });

  bot.command("reply", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const args = ctx.message.text
      .replace(/^\/reply\s*/i, "")
      .trim()
      .split(/\s+/);
    const userId = parseInt(args[0], 10);
    const msgText = args.slice(1).join(" ");
    if (!userId || !msgText) {
      await ctx.reply("Usage: /reply <user_id> <message>");
      return;
    }
    try {
      await bot.telegram.sendMessage(userId, `📩 Admin reply: ${msgText}`);
      await ctx.reply("Reply sent ✅");
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  // ── Admin commands ──────────────────────────────────────────────
  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    try {
      const { getDb } = require("../db/database");
      const d = getDb();
      const [userCount, orderCount, paidCount] = await Promise.all([
        d.collection("users").countDocuments(),
        d.collection("email_orders").countDocuments(),
        d.collection("payments").countDocuments({ status: "paid" }),
      ]);
      let apiBalance = "N/A";
      try {
        const { getBalance } = require("../services/smsActivate");
        const b = await getBalance();
        apiBalance = `${b.balance} ${b.currency}`;
      } catch {}
      await ctx.reply(
        [
          "🔐 Admin Dashboard",
          `👥 Users: ${userCount}`,
          `📧 Orders: ${orderCount}`,
          `💰 Paid: ${paidCount}`,
          `🏦 API Balance: ${apiBalance}`,
          "",
          "Commands: /approve /reject /revoke /users /user /stats",
        ].join("\n"),
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command("users", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    try {
      const d = getDb();
      const page =
        parseInt(ctx.message.text.replace(/^\/users\s*/i, ""), 10) || 1;
      const skip = (page - 1) * 10;
      const users = await d
        .collection("users")
        .find()
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(10)
        .toArray();
      if (!users.length) {
        await ctx.reply("No users found.");
        return;
      }
      const lines = users.map((u, i) => {
        const uid = u._id ? u._id.toString().slice(-6) : "?";
        return `#${skip + i + 1} ID: ...${uid} | 💎 ${formatGems(u.gems_balance || 0)} | ${u.telegram_id ? "TG:" + u.telegram_id : "Web"}`;
      });
      await ctx.reply(
        `Users (page ${page}):\n${lines.join("\n")}\n\nUse /user <telegram_id> for details`,
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command("user", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const tgId = ctx.message.text.replace(/^\/user\s*/i, "").trim();
    if (!tgId) {
      await ctx.reply("Usage: /user <telegram_id>");
      return;
    }
    try {
      const d = getDb();
      const user = await d
        .collection("users")
        .findOne({ telegram_id: String(tgId) });
      if (!user) {
        await ctx.reply("User not found.");
        return;
      }
      const userId = user._id.toString();
      const [orders, payments] = await Promise.all([
        d.collection("email_orders").countDocuments({ user_id: userId }),
        d
          .collection("payments")
          .countDocuments({ user_id: userId, status: "paid" }),
      ]);
      await ctx.reply(
        [
          `👤 User: ${user.telegram_id || "Web only"}`,
          `🆔 DB ID: #usr_${userId.slice(-8)}`,
          `💎 Balance: ${formatGems(user.gems_balance || 0)}`,
          `📧 Orders: ${orders}`,
          `💰 Payments: ${payments}`,
          `📅 Joined: ${user.created_at || "N/A"}`,
        ].join("\n"),
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command("balanceapi", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    try {
      const { getBalance } = require("../services/smsActivate");
      const bal = await getBalance();
      await ctx.reply(
        `🏦 Hero-SMS API Balance: ${bal.balance} ${bal.currency}`,
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    try {
      const d = getDb();
      const [users, orders, payments] = await Promise.all([
        d.collection("users").countDocuments(),
        d.collection("email_orders").countDocuments(),
        d.collection("payments").countDocuments({ status: "paid" }),
      ]);
      await ctx.reply(
        `📊 Stats\n👥 ${users} users\n📧 ${orders} orders\n💰 ${payments} paid`,
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // ── Approve with double confirm ───────────────────────────────
  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/approve\s*/i, ""), 10);
    if (!id) {
      const d = getDb();
      const pending = await d
        .collection("payments")
        .aggregate([
          {
            $match: {
              provider: { $in: ["manual_tng", "manual_bank"] },
              status: { $in: ["pending", "pending_review"] },
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "user_id",
              foreignField: "telegram_id",
              as: "u",
            },
          },
          { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
          { $sort: { _id: 1 } },
          { $limit: 20 },
        ])
        .toArray();
      if (!pending.length) {
        await ctx.reply("No pending manual payments.");
        return;
      }
      await ctx.reply(
        [
          "📋 Pending manual payments:",
          ...pending.map(
            (p) =>
              `#${p._id.toString().slice(-6)} RM${p.amount_myr} → ${formatGems(p.gems)} (${p.provider}) ${p.status === "pending_review" ? "📎" : ""}`,
          ),
          "",
          "Use /approve <id> to approve with confirmation",
        ].join("\n"),
      );
      return;
    }
    // Show confirmation before approving
    const d = getDb();
    const { ObjectId } = require("mongodb");
    const payment = await d
      .collection("payments")
      .findOne({ _id: new ObjectId(String(id)) });
    if (!payment) {
      await ctx.reply("Payment not found.");
      return;
    }
    await ctx.reply(
      `Confirm: Approve #${id}?\n💰 RM ${payment.amount_myr} → ${formatGems(payment.gems)} gems\n👤 user_id: ${payment.user_id}\n\nThis will credit the user's account.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirm Approve", `confirm_approve_${id}`)],
        [Markup.button.callback("❌ Cancel", `confirm_cancel`)],
      ]),
    );
  });

  bot.action(/^confirm_approve_(\w+)$/, async (ctx) => {
    // Always acknowledge immediately to stop the loading spinner
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const id = ctx.match[1];
    try {
      const result = await adminApprovePayment(id);
      const text = `✅ Approved #${id}. Credited ${formatGems(result.gems)} gems.`;
      try {
        await ctx.editMessageText(text);
      } catch {
        try {
          await ctx.reply(text);
        } catch {}
      }
      // Notify user — lookup telegram_id from users collection
      try {
        const d = getDb();
        const { ObjectId: OId } = require("mongodb");
        const payment = await d
          .collection("payments")
          .findOne({ _id: new OId(String(id)) });
        if (payment?.user_id) {
          const userDoc = await d.collection("users").findOne({
            _id:
              typeof payment.user_id === "string" &&
              payment.user_id.length === 24
                ? new OId(payment.user_id)
                : payment.user_id,
          });
          const tgId = userDoc?.telegram_id;
          if (tgId) {
            try {
              const balance = await getUserBalance(payment.user_id);
              await ctx.telegram.sendMessage(
                tgId,
                `✅ Your payment #${id} has been approved!\n\n💰 RM ${payment.amount_myr} → ${formatGems(payment.gems)} gems\n💎 New Balance: ${formatGems(balance)} gems`,
              );
            } catch (e) {
              console.error("Failed to notify user of approval:", e.message);
            }
          }
        }
      } catch {}

      // Also notify admin about the updated balance
      try {
        const d = getDb();
        const payment = await d
          .collection("payments")
          .findOne({ _id: new (require("mongodb").ObjectId)(String(id)) });
        if (payment?.user_id) {
          const balance = await getUserBalance(payment.user_id);
          await ctx.reply(
            `💎 User balance is now: ${formatGems(balance)} gems`,
          );
        }
      } catch {}
    } catch (err) {
      try {
        await ctx.editMessageText(`❌ Approve failed: ${err.message}`);
      } catch {
        try {
          await ctx.reply(`❌ Approve failed: ${err.message}`);
        } catch {}
      }
    }
  });

  bot.action("confirm_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("❌ Action cancelled.");
  });

  // ── Reject with double confirm ────────────────────────────────
  bot.command("reject", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/reject\s*/i, ""), 10);
    if (!id) {
      await ctx.reply("Usage: /reject <payment_id>");
      return;
    }
    const d = getDb();
    const { ObjectId } = require("mongodb");
    const payment = await d
      .collection("payments")
      .findOne({ _id: new ObjectId(String(id)) });
    if (!payment) {
      await ctx.reply("Payment not found.");
      return;
    }
    await ctx.reply(
      `Confirm: REJECT #${id}?\n💰 RM ${payment.amount_myr}\n\nUser will NOT receive gems.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("❌ Confirm Reject", `confirm_reject_${id}`)],
        [Markup.button.callback("↩ Cancel", `confirm_cancel`)],
      ]),
    );
  });

  bot.action(/^confirm_reject_(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const id = ctx.match[1];
    try {
      const { adminRejectPayment } = require("../services/payments");
      await adminRejectPayment(id);
      const text = `❌ Payment #${id} rejected.`;
      try {
        await ctx.editMessageText(text);
      } catch {
        try {
          await ctx.reply(text);
        } catch {}
      }
    } catch (err) {
      try {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
      } catch {
        try {
          await ctx.reply(`❌ Failed: ${err.message}`);
        } catch {}
      }
    }
  });

  // ── Revoke (undo misclick) ────────────────────────────────────
  bot.command("revoke", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/revoke\s*/i, ""), 10);
    if (!id) {
      await ctx.reply("Usage: /revoke <payment_id> — undo an approved payment");
      return;
    }
    const d = getDb();
    const { ObjectId } = require("mongodb");
    const payment = await d
      .collection("payments")
      .findOne({ _id: new ObjectId(String(id)) });
    if (!payment) {
      await ctx.reply("Payment not found.");
      return;
    }
    if (payment.status !== "paid") {
      await ctx.reply(`Cannot revoke — status is: ${payment.status}`);
      return;
    }
    await ctx.reply(
      `⚠️ Revoke #${id}?\n💰 RM ${payment.amount_myr} → ${formatGems(payment.gems)} gems will be DEDUCTED from user.\n\nStatus will reset to pending.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("↩ Confirm Revoke", `confirm_revoke_${id}`)],
        [Markup.button.callback("❌ Cancel", `confirm_cancel`)],
      ]),
    );
  });

  bot.action(/^confirm_revoke_(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const id = ctx.match[1];
    try {
      const { adminRevokePayment } = require("../services/payments");
      const result = await adminRevokePayment(id);
      const text = `↩ ${result.message}`;
      try {
        await ctx.editMessageText(text);
      } catch {
        try {
          await ctx.reply(text);
        } catch {}
      }
    } catch (err) {
      try {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
      } catch {
        try {
          await ctx.reply(`❌ Failed: ${err.message}`);
        } catch {}
      }
    }
  });

  bot.command("webhook", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const url = config.webappUrl
      ? `${config.webappUrl}/webhook/hero-sms`
      : "Not configured";
    await ctx.reply(`Webhook URL: ${url}`);
  });

  bot.command("countries", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    try {
      const countries = await getSmsCountries();
      if (!Array.isArray(countries) || !countries.length) {
        await ctx.reply("No countries returned from API.");
        return;
      }
      const list = countries
        .slice(0, 20)
        .map((c) => `• ${c.eng || c.rus || c.id} (ID: ${c.id})`)
        .join("\n");
      await ctx.reply(
        `Available SMS countries:\n${list}\n\nUse /setcountry <id> to set your default.`,
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command("setcountry", async (ctx) => {
    const id = ctx.message.text.replace(/^\/setcountry\s*/i, "").trim();
    if (!id) {
      await ctx.reply("Usage: /setcountry <country_id>");
      return;
    }
    config.smsActivateCountryId = id;
    saveUserPreference(ctx.from.id, "preferred_country", id);
    await ctx.reply(`Default SMS country set to ${id} ✅`);
  });

  bot.command("topup", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const wallet = await getWalletInfo(user.id);
    await ctx.reply(
      t(
        getUserLang(user.telegramId),
        "topup",
        wallet.exchange.gemsPerMyr.toLocaleString(),
        wallet.methods,
      ),
    );
  });

  bot.command("order", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const parts = ctx.message.text
      .replace(/^\/order\s*/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const rawSite = parts[0] || "";
    const rawDomain = parts[1] || "";

    // 🔹 新增：参数缺失时的友好提示
    if (!rawSite) {
      const appUrl = webAppUrl(user.accessToken);
      let reply = `❌ *Missing service name.*\n\nUsage: /order <site> [domain]\nExample: /order telegram\n\n🌐 Or open the Web App to browse services and order with one click:`;
      if (appUrl) {
        await ctx.reply(reply, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.webApp("🌐 Order Now", appUrl)],
          ]),
        });
      } else {
        await ctx.reply(reply + "\n\n(Web App URL not configured)", {
          parse_mode: "Markdown",
        });
      }
      return;
    }
    try {
      const { site, domain } = await resolveOrderDomain(rawDomain, rawSite);
      const { costGems } = await estimateOrderCost(domain);
      await ctx.reply(
        `Ordering ${site} @ ${domain} (${costGems.toLocaleString()} gems)...`,
      );
      const { order: saved } = await placeOrder(user.id, site, domain);
      await ctx.reply(t(getUserLang(user.telegramId), "orderPlaced", saved));
    } catch (err) {
      if (err.code === "INSUFFICIENT_GEMS") {
        await ctx.reply(
          `Not enough gems. Need ${err.requiredGems.toLocaleString()}, have ${err.balance.toLocaleString()}.`,
        );
        return;
      }
      await ctx.reply(`Order failed: ${err.message}`);
    }
  });

  bot.command("cancel", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.message.text.replace(/^\/cancel\s*/i, ""), 10);
    if (!id) {
      await ctx.reply(
        `❌ *Missing order ID.*\n\nUsage: /cancel <order_id>\nExample: /cancel 123\n\nYou can find your order IDs with /list or in the Web App.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }
    try {
      await cancelOrderWithRefund(user.id, order);
      await ctx.reply(`Cancelled order #${id}`);
    } catch (err) {
      await ctx.reply(`Cancel failed: ${err.message}`);
    }
  });

  // ── QR uploads (admin) ───────────────────────────────────────
  bot.command("setqr_tng", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    if (!ctx.message.reply_to_message?.photo) {
      await ctx.reply("Reply to a photo with /setqr_tng");
      return;
    }
    await ctx.reply("Downloading QR image...");
    try {
      const fileId = ctx.message.reply_to_message.photo.pop().file_id;
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const d = getDb();
      await d
        .collection("app_config")
        .updateOne(
          { key: "qr_tng_file_id" },
          { $set: { key: "qr_tng_file_id", value: fileId } },
          { upsert: true },
        );
      await saveQrImage(fileUrl, "qr-tng.jpg");
      await ctx.reply("✅ TnG QR saved and available in web app!");
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });
  bot.command("setqr_bank", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    if (!ctx.message.reply_to_message?.photo) {
      await ctx.reply("Reply to a photo with /setqr_bank");
      return;
    }
    await ctx.reply("Downloading QR image...");
    try {
      const fileId = ctx.message.reply_to_message.photo.pop().file_id;
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const d = getDb();
      await d
        .collection("app_config")
        .updateOne(
          { key: "qr_bank_file_id" },
          { $set: { key: "qr_bank_file_id", value: fileId } },
          { upsert: true },
        );
      await saveQrImage(fileUrl, "qr-bank.jpg");
      await ctx.reply("✅ Bank QR saved and available in web app!");
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  bot.command("adminhelp", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only.");
      return;
    }
    await ctx.reply(
      `🔐 *Admin Commands*\n\n` +
        `/admin — Dashboard overview\n` +
        `/approve [id] — List pending payments or approve specific ID\n` +
        `/reject <id> — Reject a payment\n` +
        `/revoke <id> — Revoke an approved payment\n` +
        `/users [page] — List users\n` +
        `/user <telegram_id> — Show user details\n` +
        `/stats — Quick stats\n` +
        `/block <user_id> — Block a user\n` +
        `/unblock <user_id> — Unblock a user\n` +
        `/blocked — List blocked users\n` +
        `/reply <user_id> <message> — Send a message to user\n` +
        `/setqr_tng — Set TnG QR (reply to photo)\n` +
        `/setqr_bank — Set Bank QR (reply to photo)\n` +
        `/balanceapi — Check SMS API balance\n` +
        `/countries — List SMS countries\n` +
        `/setcountry <id> — Set default country\n` +
        `/webhook — Show webhook URL\n\n` +
        `💡 Use /admin for a quick panel.`,
      { parse_mode: "Markdown" },
    );
  });

  // ── Payments ─────────────────────────────────────────────────
  bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });
  bot.on("successful_payment", async (ctx) => {
    const user = await getOrCreateTelegramUser(ctx.from.id);
    try {
      const result = await handleTelegramSuccessfulPayment(
        user.id,
        ctx.message.successful_payment,
      );
      await ctx.reply(
        `Payment received ✅\n+${formatGems(result.payment.gems)} gems\nBalance: ${formatGems(getUserBalance(user.id))} gems`,
      );
    } catch (err) {
      await ctx.reply(
        `Payment recorded but credit failed: ${err.message}. Contact support.`,
      );
    }
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });
  return bot;
}

const fs = require("fs");
const path = require("path");
const https = require("https");

async function saveQrImage(fileUrl, filename) {
  const { getDb } = require("../db/database");
  return new Promise((resolve, reject) => {
    https
      .get(fileUrl, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const b64 = buffer.toString("base64");
            const dbKey = filename.includes("tng")
              ? "qr_tng_base64"
              : "qr_bank_base64";
            const d = getDb();
            await d
              .collection("app_config")
              .updateOne(
                { key: dbKey },
                { $set: { key: dbKey, value: b64 } },
                { upsert: true },
              );
            // Also save to filesystem for static serving
            const dir = path.join(__dirname, "..", "web", "public", "qr");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, filename), buffer);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function launchBot(bot, app) {
  if (!bot) return;

  // Register commands for Telegram native / autocomplete
  try {
    // Default commands for all users
    await bot.telegram.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "balance", description: "Check gem balance" },
      { command: "topup", description: "Top up gems" },
      { command: "domains", description: "List available email domains" },
      { command: "list", description: "View active orders" },
      { command: "web", description: "Open web dashboard" },
      { command: "help", description: "Show help" },
      { command: "lang", description: "Switch language (en/zh)" },
    ]);

    // Admin commands — registered per-chat for each admin
    for (const adminId of config.adminTelegramIds) {
      await bot.telegram.setMyCommands(
        [
          { command: "start", description: "Start the bot" },
          { command: "balance", description: "Check gem balance" },
          { command: "topup", description: "Top up gems" },
          { command: "domains", description: "List available email domains" },
          { command: "list", description: "View active orders" },
          { command: "web", description: "Open web dashboard" },
          { command: "help", description: "Show help" },
          { command: "lang", description: "Switch language (en/zh)" },
          { command: "admin", description: "Admin dashboard overview" },
          {
            command: "approve",
            description: "Approve or list pending payments",
          },
          { command: "reject", description: "Reject a payment" },
          { command: "revoke", description: "Revoke an approved payment" },
          { command: "users", description: "List users" },
          { command: "user", description: "User detail by Telegram ID" },
          { command: "balanceapi", description: "Check Hero-SMS API balance" },
          { command: "stats", description: "Quick stats" },
          { command: "block", description: "Block a user" },
          { command: "unblock", description: "Unblock a user" },
          { command: "blocked", description: "List blocked users" },
          { command: "reply", description: "Reply to a user" },
          { command: "setqr_tng", description: "Set TnG QR (reply to photo)" },
          {
            command: "setqr_bank",
            description: "Set Bank QR (reply to photo)",
          },
        ],
        { scope: { type: "chat", chat_id: Number(adminId) } },
      );
    }
    console.log("Telegram commands registered (admin + default scopes)");
  } catch (e) {
    console.error("Failed to register Telegram commands:", e.message);
  }

  if (config.webappUrl) {
    try {
      await bot.telegram.setChatMenuButton({
        type: "web_app",
        text: "Open dashboard",
        web_app: { url: config.webappUrl },
      });
    } catch {}
  }
  if (config.webappUrl && config.isProduction) {
    const webhookPath = "/telegram-webhook";
    const webhookUrlFull = `${config.webappUrl}${webhookPath}`;
    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(webhookUrlFull);
    console.log(`Telegram webhook set: ${webhookUrlFull}`);
  } else {
    await bot.launch();
    console.log("Telegram bot running in polling mode (local dev)");
  }
}

let botInstance = null;

module.exports = {
  createBot,
  launchBot,
  get bot() {
    return botInstance;
  },
  setBotInstance(b) {
    botInstance = b;
  },
  webhookUrl: () =>
    config.webappUrl
      ? `${config.webappUrl}/webhook/hero-sms`
      : "Not configured",
};
