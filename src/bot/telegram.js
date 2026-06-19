const { Telegraf, Markup } = require("telegraf");
const { config } = require("../config");
const { getDomains, getEmail } = require("../services/heroSms");
const {
  getOrCreateTelegramUser,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
} = require("../services/mailStore");
const { setNotifier } = require("../services/notifier");
const { getUserBalance, formatGems } = require("../services/gems");
const { getExchangeInfo } = require("../services/exchangeRate");
const {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
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

const BTN = {
  BALANCE: "💎 Balance",
  TOPUP: "➕ Top up",
  ORDER: "🛒 Order mail",
  LIST: "📬 Active mail",
  DOMAINS: "📋 Domains",
  WEB: "🌐 Open app",
};

function webAppUrl(token) {
  if (!config.webappUrl) return null;
  return `${config.webappUrl}/?token=${token}`;
}

function webLink(token) {
  const url = webAppUrl(token);
  return url || "Set WEBAPP_URL on Render, then redeploy.";
}

function webhookUrl() {
  if (!config.webappUrl) return "Not configured";
  return `${config.webappUrl}/webhook/hero-sms`;
}

function mainInlineKeyboard(token) {
  const buttons = [
    [
      Markup.button.callback("💎 Balance", "balance"),
      Markup.button.callback("➕ Top up", "topup_menu"),
    ],
    [
      Markup.button.callback("📬 Active mail", "list"),
      Markup.button.callback("🛒 Order mail", "order_menu"),
    ],
    [
      Markup.button.callback("📋 Domains", "domains"),
      Markup.button.callback("❓ Help", "help_menu"),
    ],
  ];

  const appUrl = webAppUrl(token);
  if (appUrl) {
    buttons.push([Markup.button.webApp("🌐 Open dashboard", appUrl)]);
  }

  return Markup.inlineKeyboard(buttons);
}

function replyMainMenu(token) {
  const row1 = [BTN.BALANCE, BTN.TOPUP];
  const row2 = [BTN.ORDER, BTN.LIST];
  const row3 = [BTN.DOMAINS];

  const appUrl = webAppUrl(token);
  if (appUrl) {
    row3.push(Markup.button.webApp(BTN.WEB, appUrl));
  }

  return Markup.keyboard([row1, row2, row3]).resize().persistent();
}

function orderListKeyboard(orders) {
  const rows = orders.slice(0, 8).map((order) => {
    const buttons = [
      Markup.button.callback(`🔄 #${order.id}`, `mail_${order.id}`),
    ];
    if (!order.value && String(order.status).toUpperCase() !== "CANCELLED") {
      buttons.push(
        Markup.button.callback(`❌ #${order.id}`, `cancel_${order.id}`),
      );
    }
    return buttons;
  });

  rows.push([
    Markup.button.callback("🛒 New order", "order_menu"),
    Markup.button.callback("« Menu", "main_menu"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function formatMailAlert(order, source) {
  return [
    "📨 Mail received!",
    "",
    formatOrder(order),
    "",
    `Source: ${source}`,
    `Dashboard: ${webLink(findTokenForOrder(order))}`,
  ].join("\n");
}

function findTokenForOrder(order) {
  const { getDb } = require("../db/database");
  const row = getDb()
    .prepare(
      `
      SELECT u.access_token FROM users u
      JOIN email_orders e ON e.user_id = u.id
      WHERE e.id = ?
    `,
    )
    .get(order.id);
  return row?.access_token || "";
}

async function formatBalanceMessage(userId) {
  const wallet = await getWalletInfo(userId);
  const ex = wallet.exchange;
  return [
    `💎 Balance: ${formatGems(wallet.balance)} gems`,
    `Rate: 1 MYR = ${ex.gemsPerMyr.toLocaleString()} gems`,
    `(USD/MYR ${ex.usdMyr.toFixed(4)}, base ${ex.baseUsdMyr})`,
    "",
    `Formula: ${ex.formula}`,
  ].join("\n");
}

async function showTopupMenu(ctx, user) {
  const wallet = await getWalletInfo(user.id);
  const buttons = wallet.packages.map((pkg) => [
    Markup.button.callback(
      `${pkg.name} — RM${pkg.priceMyr}`,
      `topup_pkg_${pkg.id}`,
    ),
  ]);
  buttons.push([Markup.button.callback("Custom amount (web)", "topup_web")]);
  buttons.push([Markup.button.callback("« Menu", "main_menu")]);

  await ctx.reply(
    [
      "Choose a gem package:",
      `Current rate: 1 MYR = ${wallet.exchange.gemsPerMyr.toLocaleString()} gems`,
      "",
      wallet.methods.map((m) => `• ${m.name}`).join("\n") ||
        "Configure payment env vars on server.",
    ].join("\n"),
    Markup.inlineKeyboard(buttons),
  );
}

async function showOrderList(ctx, user) {
  const orders = listOrders(user.id, { limit: 20 });
  const text = formatOrderList(orders);
  const extra = orders.length
    ? orderListKeyboard(orders)
    : mainInlineKeyboard(user.accessToken);
  await ctx.reply(text, extra);
}

async function showDomains(ctx) {
  try {
    const domains = await getDomains();
    const ex = await getExchangeInfo();
    const list = (Array.isArray(domains) ? domains : []).slice(0, 12);

    const lines = await Promise.all(
      list.map(async (d) => {
        const name = d.name || d.domain;
        const { costGems } = await estimateOrderCost(name);
        return `• ${name} — ${costGems.toLocaleString()} gems, stock ${d.count}`;
      }),
    );
    lines.unshift(`Rate: 1 MYR = ${ex.gemsPerMyr.toLocaleString()} gems`);

    const domainButtons = list.slice(0, 6).map((d) => {
      const name = d.name || d.domain;
      return [
        Markup.button.callback(
          `Order @ ${name}`,
          `order_domain_${encodeURIComponent(name)}`,
        ),
      ];
    });
    domainButtons.push([Markup.button.callback("« Menu", "main_menu")]);

    await ctx.reply(
      lines.length > 1 ? lines.join("\n") : "No domains returned.",
      Markup.inlineKeyboard(domainButtons),
    );
  } catch (err) {
    await ctx.reply(`Hero-SMS error: ${err.message}`);
  }
}

async function showOrderMenu(ctx, user) {
  const { costGems } = await estimateOrderCost(config.defaultDomain);
  await ctx.reply(
    [
      "Quick order:",
      `${config.defaultSite} @ ${config.defaultDomain} (${costGems.toLocaleString()} gems)`,
      "",
      "Tap a button or pick a domain from 📋 Domains.",
    ].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `🛒 Order ${config.defaultDomain}`,
          "order_default",
        ),
      ],
      [Markup.button.callback("📋 Pick domain", "domains")],
      [Markup.button.callback("« Menu", "main_menu")],
    ]),
  );
}

async function showMainMenu(ctx, user, greeting) {
  const name = greeting || ctx.from?.first_name || "there";
  const inline = mainInlineKeyboard(user.accessToken);
  const reply = replyMainMenu(user.accessToken);

  await ctx.reply(
    [
      `Hi ${name}! 👋`,
      "",
      "Use the buttons below for quick actions.",
      "Open 🌐 Open app for the full dashboard inside Telegram.",
      "",
      "Advanced commands still work: /cancel <id>, /mail <id>, /approve (admin).",
    ].join("\n"),
    {
      reply_markup: {
        ...inline.reply_markup,
        ...reply.reply_markup,
      },
    },
  );
}

function createBot() {
  if (!config.botToken) {
    console.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  const bot = new Telegraf(config.botToken);

  setNotifier(async (order, source) => {
    const { getDb } = require("../db/database");
    const user = getDb()
      .prepare(
        `
        SELECT u.telegram_id FROM users u
        JOIN email_orders e ON e.user_id = u.id
        WHERE e.id = ?
      `,
      )
      .get(order.id);

    if (!user?.telegram_id) return;

    const token = findTokenForOrder(order);
    const appUrl = webAppUrl(token);
    const extra = appUrl
      ? Markup.inlineKeyboard([
          [Markup.button.webApp("🌐 View in app", appUrl)],
        ])
      : undefined;

    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        formatMailAlert(order, source),
        {
          parse_mode: undefined,
          disable_web_page_preview: true,
          ...(extra ? { reply_markup: extra.reply_markup } : {}),
        },
      );
    } catch (err) {
      console.error("Telegram notify failed:", err.message);
    }
  });

  bot.start(async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await showMainMenu(ctx, user, ctx.from.first_name);
  });

  bot.command("help", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.reply(
      [
        "Quick actions: use the keyboard buttons or inline menu.",
        "",
        "Commands (optional):",
        "/balance · /topup · /order [site] [domain]",
        "/list · /mail <id> · /domains · /cancel <id> · /web",
      ].join("\n"),
      mainInlineKeyboard(user.accessToken),
    );
  });

  bot.hears(
    Object.values(BTN).filter((b) => typeof b === "string"),
    async (ctx) => {
      const user = getOrCreateTelegramUser(ctx.from.id);
      const text = ctx.message.text;

      if (text === BTN.BALANCE) {
        await ctx.reply(
          await formatBalanceMessage(user.id),
          mainInlineKeyboard(user.accessToken),
        );
        return;
      }
      if (text === BTN.TOPUP) {
        await showTopupMenu(ctx, user);
        return;
      }
      if (text === BTN.LIST) {
        await showOrderList(ctx, user);
        return;
      }
      if (text === BTN.ORDER) {
        await showOrderMenu(ctx, user);
        return;
      }
      if (text === BTN.DOMAINS) {
        await showDomains(ctx);
      }
    },
  );

  bot.command("balance", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.reply(
      await formatBalanceMessage(user.id),
      mainInlineKeyboard(user.accessToken),
    );
  });

  bot.command("topup", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await showTopupMenu(ctx, user);
  });

  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply("Admin only.");
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/approve\s*/i, ""), 10);
    if (!id) {
      const pending = listPendingManualPayments();
      if (!pending.length) {
        await ctx.reply("No pending manual payments.");
        return;
      }
      const lines = pending.map(
        (p) =>
          `#${p.id} user ${p.telegramId || p.userId} RM${p.amountMyr} → ${formatGems(p.gems)} gems (${p.provider})`,
      );
      await ctx.reply(
        ["Pending payments:", ...lines, "", "Use /approve <id>"].join("\n"),
      );
      return;
    }
    try {
      const result = await adminApprovePayment(id);
      await ctx.reply(
        `Approved #${id}. Credited ${formatGems(result.payment.gems)} gems. New balance tracked in ledger.`,
      );
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  bot.command("webhook", async (ctx) => {
    await ctx.reply(
      [
        "Configure this URL in your Hero-SMS webhook settings:",
        webhookUrl(),
        "",
        config.webhookSecret
          ? "Webhook secret is enabled on this server."
          : "Optional: set WEBHOOK_SECRET in env.",
      ].join("\n"),
    );
  });

  bot.command("web", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const appUrl = webAppUrl(user.accessToken);
    const extra = appUrl
      ? Markup.inlineKeyboard([
          [Markup.button.webApp("🌐 Open dashboard", appUrl)],
        ])
      : mainInlineKeyboard(user.accessToken);
    await ctx.reply("Open your dashboard:", extra);
  });

  bot.command("domains", async (ctx) => {
    await showDomains(ctx);
  });

  bot.command("list", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await showOrderList(ctx, user);
  });

  bot.command("mail", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.message.text.replace(/^\/mail\s*/i, ""), 10);
    if (!id) {
      await ctx.reply("Usage: /mail 1");
      return;
    }

    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = saveOrder(user.id, remote);
      await ctx.reply(
        formatOrder(updated),
        mainInlineKeyboard(user.accessToken),
      );
    } catch {
      await ctx.reply(formatOrder(order), mainInlineKeyboard(user.accessToken));
    }
  });

  bot.command("order", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const parts = ctx.message.text
      .replace(/^\/order\s*/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const site = parts[0] || config.defaultSite;
    const domain = parts[1] || config.defaultDomain;

    try {
      const { costGems } = await estimateOrderCost(domain);
      await ctx.reply(
        `Ordering ${site} @ ${domain} (${costGems.toLocaleString()} gems)…`,
      );
      const { order: saved } = await placeOrder(user.id, site, domain);
      await ctx.reply(
        [
          "Order placed ✅",
          "",
          formatOrder(saved),
          "",
          "Watching for incoming mail…",
        ].join("\n"),
        mainInlineKeyboard(user.accessToken),
      );
    } catch (err) {
      if (err.code === "INSUFFICIENT_GEMS") {
        await ctx.reply(
          `Not enough gems. Need ${err.requiredGems.toLocaleString()}, have ${err.balance.toLocaleString()}.\nTap ➕ Top up.`,
          mainInlineKeyboard(user.accessToken),
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
      await ctx.reply(
        `Cancelled order #${id}`,
        mainInlineKeyboard(user.accessToken),
      );
    } catch (err) {
      await ctx.reply(`Cancel failed: ${err.message}`);
    }
  });

  bot.action("main_menu", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await showMainMenu(ctx, user);
  });

  bot.action("help_menu", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "💎 Balance — gems & exchange rate",
        "➕ Top up — buy gems (FPX, TnG, Stars, bank)",
        "🛒 Order mail — disposable email for activations",
        "📬 Active mail — your orders + refresh/cancel buttons",
        "📋 Domains — prices & one-tap order",
        "🌐 Open app — full web dashboard inside Telegram",
      ].join("\n"),
      mainInlineKeyboard(user.accessToken),
    );
  });

  bot.action("balance", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.reply(
      await formatBalanceMessage(user.id),
      mainInlineKeyboard(user.accessToken),
    );
  });

  bot.action("topup_menu", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await showTopupMenu(ctx, user);
  });

  bot.action(/^topup_pkg_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const methods = [];
    if (config.telegramPaymentProviderToken) {
      methods.push([
        Markup.button.callback("⭐ Telegram Stars", `pay_stars_${packageId}`),
      ]);
    }
    if (config.billplzApiKey) {
      methods.push([
        Markup.button.callback(
          "💳 FPX / Card / TnG",
          `pay_billplz_${packageId}`,
        ),
      ]);
    }
    if (config.manualTngPhone) {
      methods.push([
        Markup.button.callback("📱 TnG manual", `pay_tng_${packageId}`),
      ]);
    }
    if (config.manualBankAccount) {
      methods.push([
        Markup.button.callback("🏦 Bank transfer", `pay_bank_${packageId}`),
      ]);
    }

    if (!methods.length) {
      await ctx.reply("No payment methods configured on server.");
      return;
    }

    await ctx.reply("Select payment method:", Markup.inlineKeyboard(methods));
  });

  bot.action(/^pay_billplz_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, {
        method: "billplz",
        packageId,
      });
      await ctx.reply(
        `Pay here (FPX / card / TnG / GrabPay):\n${result.billUrl}`,
      );
    } catch (err) {
      await ctx.reply(`Payment error: ${err.message}`);
    }
  });

  async function sendManualPayment(ctx, result, title) {
    const caption = [
      `${title} — Manual Payment`,
      "",
      ...result.instructions,
      "",
      `Payment ID: #${result.paymentId}`,
    ].join("\n");

    if (result.qrUrl) {
      try {
        await ctx.replyWithPhoto(result.qrUrl, { caption });
        return;
      } catch {
        // QR URL may not be a direct image (e.g. Google Drive) — fallback to text
      }
    }
    await ctx.reply(caption);
  }

  bot.action(/^pay_tng_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, {
        method: "manual_tng",
        packageId,
      });
      await sendManualPayment(ctx, result, "📱 Touch n Go eWallet");
    } catch (err) {
      await ctx.reply(`Payment error: ${err.message}`);
    }
  });

  bot.action(/^pay_bank_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, {
        method: "manual_bank",
        packageId,
      });
      await sendManualPayment(ctx, result, "🏦 Bank Transfer");
    } catch (err) {
      await ctx.reply(`Payment error: ${err.message}`);
    }
  });

  bot.action(/^pay_stars_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    try {
      const wallet = await getWalletInfo(user.id);
      const pkg = wallet.packages.find((p) => p.id === packageId);
      if (!pkg) throw new Error("Package not found");

      const stars = Math.max(1, Math.ceil(pkg.priceMyr / config.myrPerStar));
      const payload = JSON.stringify({
        userId: user.id,
        packageId,
        gems: pkg.gems,
      });

      await ctx.replyWithInvoice(
        buildStarsPayload({
          title: pkg.name,
          description: `${pkg.gems.toLocaleString()} gems for Hero-SMS orders`,
          starCount: stars,
          payload,
        }),
      );
    } catch (err) {
      await ctx.reply(`Stars payment error: ${err.message}`);
    }
  });

  bot.action("topup_web", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    const appUrl = webAppUrl(user.accessToken);
    if (appUrl) {
      await ctx.reply(
        "Top up on the dashboard:",
        Markup.inlineKeyboard([
          [Markup.button.webApp("🌐 Open top-up", `${appUrl}#topup`)],
        ]),
      );
      return;
    }
    await ctx.reply(`Top up on web:\n${webLink(user.accessToken)}#topup`);
  });

  bot.action("list", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await showOrderList(ctx, user);
  });

  bot.action("order_menu", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await showOrderMenu(ctx, user);
  });

  bot.action("domains", async (ctx) => {
    await ctx.answerCbQuery();
    await showDomains(ctx);
  });

  bot.action(/^order_domain_(.+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const domain = decodeURIComponent(ctx.match[1]);
    await ctx.answerCbQuery();

    try {
      const { costGems } = await estimateOrderCost(domain);
      await ctx.reply(
        `Ordering ${config.defaultSite} @ ${domain} (${costGems.toLocaleString()} gems)…`,
      );
      const { order: saved } = await placeOrder(
        user.id,
        config.defaultSite,
        domain,
      );
      await ctx.reply(
        [
          "Order placed ✅",
          "",
          formatOrder(saved),
          "",
          "Watching for incoming mail…",
        ].join("\n"),
        mainInlineKeyboard(user.accessToken),
      );
    } catch (err) {
      if (err.code === "INSUFFICIENT_GEMS") {
        await ctx.reply(
          `Not enough gems. Tap ➕ Top up.`,
          mainInlineKeyboard(user.accessToken),
        );
        return;
      }
      await ctx.reply(`Order failed: ${err.message}`);
    }
  });

  bot.action("order_default", async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();

    try {
      const { order: saved } = await placeOrder(
        user.id,
        config.defaultSite,
        config.defaultDomain,
      );
      await ctx.reply(
        [
          "Order placed ✅",
          "",
          formatOrder(saved),
          "",
          "Watching for incoming mail…",
        ].join("\n"),
        mainInlineKeyboard(user.accessToken),
      );
    } catch (err) {
      if (err.code === "INSUFFICIENT_GEMS") {
        await ctx.reply(
          `Not enough gems. Tap ➕ Top up.`,
          mainInlineKeyboard(user.accessToken),
        );
        return;
      }
      await ctx.reply(`Order failed: ${err.message}`);
    }
  });

  bot.action(/^mail_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = saveOrder(user.id, remote);
      await ctx.reply(
        formatOrder(updated),
        orderListKeyboard(listOrders(user.id, { limit: 20 })),
      );
    } catch {
      await ctx.reply(
        formatOrder(order),
        orderListKeyboard(listOrders(user.id, { limit: 20 })),
      );
    }
  });

  bot.action(/^cancel_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }

    try {
      await cancelOrderWithRefund(user.id, order);
      await ctx.reply(
        `Cancelled order #${id}`,
        orderListKeyboard(listOrders(user.id, { limit: 20 })),
      );
    } catch (err) {
      await ctx.reply(`Cancel failed: ${err.message}`);
    }
  });

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
        mainInlineKeyboard(user.accessToken),
      );
    } catch (err) {
      await ctx.reply(
        `Payment recorded but credit failed: ${err.message}. Contact support with payment ID.`,
      );
    }
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  return bot;
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
      console.log("Telegram menu button set to web app");
    } catch (err) {
      console.warn("Could not set menu button:", err.message);
    }
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

module.exports = { createBot, launchBot, webhookUrl };
