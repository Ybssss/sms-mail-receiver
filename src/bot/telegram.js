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
      `Hi ${name}! 👋\n\nWelcome to SMS Mail Receiver.\nUse the buttons below or open the web dashboard:\n🌐 Open App`,
    balance: (bal, rate) =>
      `💎 Balance: ${bal} gems\n📊 Rate: 1 MYR = ${rate} gems`,
    noGems: "You have no gems. Tap ➕ Top up to buy gems.",
    topup: (rate, methods) =>
      `Choose a package:\nRate: 1 MYR = ${rate} gems\n\n${methods.map((m) => `• ${m.name}`).join("\n") || "Configure payment env vars."}`,
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
    help: "Commands: /start /balance /topup /domains /list /web\nAdmin: /approve /block /unblock /blocked /countries",
  },
  "zh-CN": {
    hi: (name) =>
      `你好 ${name}！👋\n\n欢迎使用SMS邮件接收器。\n使用下方按钮或打开网页面板：\n🌐 打开应用`,
    balance: (bal, rate) =>
      `💎 余额: ${bal} 宝石\n📊 汇率: 1 MYR = ${rate} 宝石`,
    noGems: "您没有宝石。请点击 ➕ 充值。",
    topup: (rate, methods) =>
      `选择套餐：\n汇率: 1 MYR = ${rate} 宝石\n\n${methods.map((m) => `• ${m.name}`).join("\n") || "请配置支付环境。"}`,
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
    help: "命令: /start /balance /topup /domains /list /web\n管理员: /approve /block /unblock /blocked /countries",
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

function findTokenForOrder(order) {
  const { getDb } = require("../db/database");
  const row = getDb()
    .prepare(
      "SELECT u.access_token FROM users u JOIN email_orders e ON e.user_id = u.id WHERE e.id = ?",
    )
    .get(order.id);
  return row?.access_token || "";
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
    const user = getDb()
      .prepare(
        "SELECT u.telegram_id FROM users u JOIN email_orders e ON e.user_id = u.id WHERE e.id = ?",
      )
      .get(order.id);
    if (!user?.telegram_id) return;
    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        formatMailAlert(order, source),
        { disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Notify failed:", err.message);
    }
  });

  // ── Block check middleware ────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.from && isUserBlocked(ctx.from.id)) {
      try {
        await ctx.reply(t(getUserLang(ctx.from.id), "blocked"));
      } catch {}
      return;
    }
    await next();
  });

  // ── Start ────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const name = ctx.from?.first_name || "there";
    const appUrl = webAppUrl(user.accessToken);
    const lines = [t(lang, "hi", name), ""];
    if (!appUrl) lines.push("WEBAPP_URL not configured.");
    const extra = appUrl
      ? Markup.inlineKeyboard([
          [Markup.button.webApp("🌐 Open Dashboard", appUrl)],
        ])
      : undefined;
    await ctx.reply(lines.join("\n"), {
      reply_markup: replyKeyboard(user.accessToken, user.telegramId)
        .reply_markup,
      ...(extra ? extra : {}),
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
    const user = getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const text = await formatBalance(user.id, lang);
    await ctx.reply(text, replyKeyboard(user.accessToken, user.telegramId));
  });
  bot.command("balance", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const text = await formatBalance(user.id, getUserLang(user.telegramId));
    await ctx.reply(text);
  });

  // ── Top up ───────────────────────────────────────────────────
  bot.hears(/^(➕ Top up|➕ 充值)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
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
    const user = getOrCreateTelegramUser(ctx.from.id);
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
    const user = getOrCreateTelegramUser(ctx.from.id);
    const lang = getUserLang(user.telegramId);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.reply(
      t(lang, "orders", orders),
      replyKeyboard(user.accessToken, user.telegramId),
    );
  });
  bot.command("list", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
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
    const user = getOrCreateTelegramUser(ctx.from.id);
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
    const user = getOrCreateTelegramUser(ctx.from.id);
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
  bot.action(/^admin_reply_(\d+)_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin only");
      return;
    }
    const userId = parseInt(ctx.match[1], 10);
    const code = ctx.match[2];
    await ctx.answerCbQuery();
    await ctx.reply(
      `Redirect message to user ${userId}: /reply ${userId} #${code} <your message>`,
    );
  });

  bot.action(/^admin_block_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin only");
      return;
    }
    const userId = parseInt(ctx.match[1], 10);
    blockUser(userId, "Admin block", ctx.from.id);
    await ctx.answerCbQuery("User blocked ✅");
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {}
  });

  bot.action(/^admin_unblock_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin only");
      return;
    }
    const userId = parseInt(ctx.match[1], 10);
    unblockUser(userId);
    await ctx.answerCbQuery("User unblocked ✅");
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {}
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

  // ── Approve ──────────────────────────────────────────────────
  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only");
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/approve\s*/i, ""), 10);
    if (!id) {
      const pending = listPendingManualPayments();
      if (!pending.length) {
        await ctx.reply("No pending manual payments.");
        return;
      }
      await ctx.reply(
        [
          "Pending:",
          ...pending.map(
            (p) =>
              `#${p.id} RM${p.amountMyr} → ${formatGems(p.gems)} (${p.provider})`,
          ),
          "",
          "Use /approve <id>",
        ].join("\n"),
      );
      return;
    }
    try {
      const result = await adminApprovePayment(id);
      await ctx.reply(
        `Approved #${id}. Credited ${formatGems(result.payment.gems)} gems.`,
      );
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  bot.command("webhook", async (ctx) => {
    const url = config.webappUrl
      ? `${config.webappUrl}/webhook/hero-sms`
      : "Not configured";
    await ctx.reply(`Webhook URL: ${url}`);
  });

  bot.command("countries", async (ctx) => {
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
    const user = getOrCreateTelegramUser(ctx.from.id);
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
    const user = getOrCreateTelegramUser(ctx.from.id);
    const parts = ctx.message.text
      .replace(/^\/order\s*/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const rawSite = parts[0] || "";
    const rawDomain = parts[1] || "";
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
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.message.text.replace(/^\/cancel\s*/i, ""), 10);
    if (!id) {
      await ctx.reply("Usage: /cancel 1");
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
      // Save file_id for in-chat display
      require("../db/database")
        .getDb()
        .prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
        .run("qr_tng_file_id", fileId);
      // Download and save as public file
      await saveQrImage(fileUrl, "qr-tng.png");
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
      require("../db/database")
        .getDb()
        .prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
        .run("qr_bank_file_id", fileId);
      await saveQrImage(fileUrl, "qr-bank.png");
      await ctx.reply("✅ Bank QR saved and available in web app!");
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  // ── Payments ─────────────────────────────────────────────────
  bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });
  bot.on("successful_payment", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
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
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const b64 = buffer.toString("base64");
          const dbKey =
            filename === "qr-tng.png" ? "qr_tng_base64" : "qr_bank_base64";
          getDb()
            .prepare(
              "INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)",
            )
            .run(dbKey, b64);
          // Also save to filesystem for static serving
          const dir = path.join(__dirname, "..", "web", "public", "qr");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, filename), buffer);
          resolve();
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function launchBot(bot, app) {
  if (!bot) return;
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
  get bot() { return botInstance; },
  setBotInstance(b) { botInstance = b; },
  webhookUrl: () =>
    config.webappUrl
      ? `${config.webappUrl}/webhook/hero-sms`
      : "Not configured",
};
