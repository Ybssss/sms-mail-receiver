const { Telegraf, Markup } = require('telegraf');
const { config } = require('../config');
const { getDomains, getEmail } = require('../services/heroSms');
const {
  getOrCreateTelegramUser,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
} = require('../services/mailStore');
const { setNotifier } = require('../services/notifier');
const { getUserBalance, formatGems } = require('../services/gems');
const { getExchangeInfo } = require('../services/exchangeRate');
const { placeOrder, cancelOrderWithRefund, estimateOrderCost } = require('../services/orderService');
const {
  createTopup,
  getWalletInfo,
  handleTelegramSuccessfulPayment,
  isAdmin,
  adminApprovePayment,
} = require('../services/payments');
const { listPendingManualPayments } = require('../services/payments/store');
const { buildStarsPayload } = require('../services/payments/telegramStars');

function webLink(token) {
  if (!config.webappUrl) {
    return 'Set WEBAPP_URL on Render, then redeploy.';
  }
  return `${config.webappUrl}/?token=${token}`;
}

function webhookUrl() {
  if (!config.webappUrl) return 'Not configured';
  return `${config.webappUrl}/webhook/hero-sms`;
}

function mainKeyboard(token) {
  const buttons = [
    [Markup.button.callback('💎 Balance', 'balance'), Markup.button.callback('➕ Top up', 'topup_menu')],
    [Markup.button.callback('📬 Active mail', 'list'), Markup.button.callback('🛒 Order mail', 'order_default')],
  ];

  if (config.webappUrl) {
    buttons.push([Markup.button.url('🌐 Web dashboard', webLink(token))]);
  }

  return Markup.inlineKeyboard(buttons);
}

function formatMailAlert(order, source) {
  return [
    '📨 Mail received!',
    '',
    formatOrder(order),
    '',
    `Source: ${source}`,
    `Dashboard: ${webLink(findTokenForOrder(order))}`,
  ].join('\n');
}

function findTokenForOrder(order) {
  const { getDb } = require('../db/database');
  const row = getDb()
    .prepare(`
      SELECT u.access_token FROM users u
      JOIN email_orders e ON e.user_id = u.id
      WHERE e.id = ?
    `)
    .get(order.id);
  return row?.access_token || '';
}

async function formatBalanceMessage(userId) {
  const wallet = await getWalletInfo(userId);
  const ex = wallet.exchange;
  return [
    `💎 Balance: ${formatGems(wallet.balance)} gems`,
    `Rate: 1 MYR = ${ex.gemsPerMyr.toLocaleString()} gems`,
    `(USD/MYR ${ex.usdMyr.toFixed(4)}, base ${ex.baseUsdMyr})`,
    '',
    `Formula: ${ex.formula}`,
  ].join('\n');
}

function createBot() {
  if (!config.botToken) {
    console.warn('TELEGRAM_BOT_TOKEN not set — bot disabled');
    return null;
  }

  const bot = new Telegraf(config.botToken);

  setNotifier(async (order, source) => {
    const { getDb } = require('../db/database');
    const user = getDb()
      .prepare(`
        SELECT u.telegram_id FROM users u
        JOIN email_orders e ON e.user_id = u.id
        WHERE e.id = ?
      `)
      .get(order.id);

    if (!user?.telegram_id) return;

    try {
      await bot.telegram.sendMessage(user.telegram_id, formatMailAlert(order, source), {
        parse_mode: undefined,
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('Telegram notify failed:', err.message);
    }
  });

  bot.start(async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.reply(
      [
        `Welcome, ${ctx.from.first_name}!`,
        '',
        'Automated Hero-SMS mail receiver with gems wallet.',
        'Top up gems, order disposable emails, get codes instantly.',
        '',
        'Commands:',
        '/balance — gems balance & exchange rate',
        '/topup — buy gems (FPX, TnG, Stars, bank)',
        '/order [site] [domain] — buy email',
        '/list — active orders',
        '/mail <id> — order details',
        '/domains — available domains + gem prices',
        '/cancel <id> — cancel order (refund gems if no mail)',
        '/web — web dashboard link',
        '/help — help',
      ].join('\n'),
      mainKeyboard(user.accessToken)
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '/balance',
        '/topup',
        '/order telegram.com gmail.com',
        '/list',
        '/mail 1',
        '/domains',
        '/cancel 1',
        '/web',
      ].join('\n')
    );
  });

  bot.command('balance', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.reply(await formatBalanceMessage(user.id), mainKeyboard(user.accessToken));
  });

  bot.command('topup', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const wallet = await getWalletInfo(user.id);
    const buttons = wallet.packages.map((pkg) => [
      Markup.button.callback(`${pkg.name} — RM${pkg.priceMyr}`, `topup_pkg_${pkg.id}`),
    ]);
    buttons.push([Markup.button.callback('Custom amount (web)', 'topup_web')]);
    await ctx.reply(
      [
        'Choose a gem package:',
        `Current rate: 1 MYR = ${wallet.exchange.gemsPerMyr.toLocaleString()} gems`,
        '',
        wallet.methods.map((m) => `• ${m.name}`).join('\n') || 'Configure payment env vars on server.',
      ].join('\n'),
      Markup.inlineKeyboard(buttons)
    );
  });

  bot.command('approve', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('Admin only.');
      return;
    }
    const id = parseInt(ctx.message.text.replace(/^\/approve\s*/i, ''), 10);
    if (!id) {
      const pending = listPendingManualPayments();
      if (!pending.length) {
        await ctx.reply('No pending manual payments.');
        return;
      }
      const lines = pending.map((p) => `#${p.id} user ${p.telegramId || p.userId} RM${p.amountMyr} → ${formatGems(p.gems)} gems (${p.provider})`);
      await ctx.reply(['Pending payments:', ...lines, '', 'Use /approve <id>'].join('\n'));
      return;
    }
    try {
      const result = await adminApprovePayment(id);
      await ctx.reply(`Approved #${id}. Credited ${formatGems(result.payment.gems)} gems. New balance tracked in ledger.`);
    } catch (err) {
      await ctx.reply(`Failed: ${err.message}`);
    }
  });

  bot.command('webhook', async (ctx) => {
    await ctx.reply(
      [
        'Configure this URL in your Hero-SMS webhook settings:',
        webhookUrl(),
        '',
        config.webhookSecret ? 'Webhook secret is enabled on this server.' : 'Optional: set WEBHOOK_SECRET in env.',
      ].join('\n')
    );
  });

  bot.command('web', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.reply(`Web dashboard:\n${webLink(user.accessToken)}`, mainKeyboard(user.accessToken));
  });

  bot.command('domains', async (ctx) => {
    try {
      const domains = await getDomains();
      const ex = await getExchangeInfo();
      const lines = await Promise.all(
        (Array.isArray(domains) ? domains : []).slice(0, 20).map(async (d) => {
          const { costGems } = await estimateOrderCost(d.name || d.domain);
          return `• ${d.name} — ${costGems.toLocaleString()} gems, stock ${d.count}`;
        })
      );
      lines.unshift(`Rate: 1 MYR = ${ex.gemsPerMyr.toLocaleString()} gems`);
      await ctx.reply(lines.length > 1 ? lines.join('\n') : 'No domains returned.');
    } catch (err) {
      await ctx.reply(`Hero-SMS error: ${err.message}`);
    }
  });

  bot.command('list', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.reply(formatOrderList(orders), mainKeyboard(user.accessToken));
  });

  bot.command('mail', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.message.text.replace(/^\/mail\s*/i, ''), 10);
    if (!id) {
      await ctx.reply('Usage: /mail 1');
      return;
    }

    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply('Order not found.');
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = saveOrder(user.id, remote);
      await ctx.reply(formatOrder(updated), mainKeyboard(user.accessToken));
    } catch {
      await ctx.reply(formatOrder(order), mainKeyboard(user.accessToken));
    }
  });

  bot.command('order', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const parts = ctx.message.text.replace(/^\/order\s*/i, '').trim().split(/\s+/).filter(Boolean);
    const site = parts[0] || config.defaultSite;
    const domain = parts[1] || config.defaultDomain;

    try {
      const { costGems } = await estimateOrderCost(domain);
      await ctx.reply(`Ordering ${site} @ ${domain} (${costGems.toLocaleString()} gems)…`);
      const { order: saved } = await placeOrder(user.id, site, domain);
      await ctx.reply(
        ['Order placed ✅', '', formatOrder(saved), '', 'Watching for incoming mail…'].join('\n'),
        mainKeyboard(user.accessToken)
      );
    } catch (err) {
      if (err.code === 'INSUFFICIENT_GEMS') {
        await ctx.reply(
          `Not enough gems. Need ${err.requiredGems.toLocaleString()}, have ${err.balance.toLocaleString()}.\nUse /topup to buy gems.`,
          mainKeyboard(user.accessToken)
        );
        return;
      }
      await ctx.reply(`Order failed: ${err.message}`);
    }
  });

  bot.command('cancel', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const id = parseInt(ctx.message.text.replace(/^\/cancel\s*/i, ''), 10);
    if (!id) {
      await ctx.reply('Usage: /cancel 1');
      return;
    }

    const order = getOrderById(id, user.id);
    if (!order) {
      await ctx.reply('Order not found.');
      return;
    }

    try {
      await cancelOrderWithRefund(user.id, order);
      await ctx.reply(`Cancelled order #${id}`, mainKeyboard(user.accessToken));
    } catch (err) {
      await ctx.reply(`Cancel failed: ${err.message}`);
    }
  });

  bot.action('balance', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.reply(await formatBalanceMessage(user.id), mainKeyboard(user.accessToken));
  });

  bot.action('topup_menu', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    const wallet = await getWalletInfo(user.id);
    const buttons = wallet.packages.map((pkg) => [
      Markup.button.callback(`${pkg.name} — RM${pkg.priceMyr}`, `topup_pkg_${pkg.id}`),
    ]);
    await ctx.reply('Choose package:', Markup.inlineKeyboard(buttons));
  });

  bot.action(/^topup_pkg_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const methods = [];
    if (config.telegramPaymentProviderToken) {
      methods.push([Markup.button.callback('⭐ Telegram Stars', `pay_stars_${packageId}`)]);
    }
    if (config.billplzApiKey) {
      methods.push([Markup.button.callback('💳 FPX / Card / TnG', `pay_billplz_${packageId}`)]);
    }
    if (config.manualTngPhone) {
      methods.push([Markup.button.callback('📱 TnG manual', `pay_tng_${packageId}`)]);
    }
    if (config.manualBankAccount) {
      methods.push([Markup.button.callback('🏦 Bank transfer', `pay_bank_${packageId}`)]);
    }

    if (!methods.length) {
      await ctx.reply('No payment methods configured on server.');
      return;
    }

    await ctx.reply('Select payment method:', Markup.inlineKeyboard(methods));
  });

  bot.action(/^pay_billplz_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, { method: 'billplz', packageId });
      await ctx.reply(`Pay here (FPX / card / TnG / GrabPay):\n${result.billUrl}`);
    } catch (err) {
      await ctx.reply(`Payment error: ${err.message}`);
    }
  });

  bot.action(/^pay_tng_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, { method: 'manual_tng', packageId });
      await ctx.reply(['Touch n Go top-up:', ...result.instructions, '', `Payment ID: #${result.paymentId}`].join('\n'));
    } catch (err) {
      await ctx.reply(`Payment error: ${err.message}`);
    }
  });

  bot.action(/^pay_bank_(\d+)$/, async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const packageId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    try {
      const result = await createTopup(user.id, { method: 'manual_bank', packageId });
      await ctx.reply(['Bank transfer:', ...result.instructions, '', `Payment ID: #${result.paymentId}`].join('\n'));
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
      if (!pkg) throw new Error('Package not found');

      const stars = Math.max(1, Math.ceil(pkg.priceMyr / config.myrPerStar));
      const payload = JSON.stringify({ userId: user.id, packageId, gems: pkg.gems });

      await ctx.replyWithInvoice(
        buildStarsPayload({
          title: pkg.name,
          description: `${pkg.gems.toLocaleString()} gems for Hero-SMS orders`,
          starCount: stars,
          payload,
        })
      );
    } catch (err) {
      await ctx.reply(`Stars payment error: ${err.message}`);
    }
  });

  bot.action('topup_web', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.reply(`Top up on web:\n${webLink(user.accessToken)}#topup`);
  });

  bot.action('list', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.answerCbQuery();
    await ctx.reply(formatOrderList(orders), mainKeyboard(user.accessToken));
  });

  bot.action('order_default', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();

    try {
      const { order: saved } = await placeOrder(user.id, config.defaultSite, config.defaultDomain);
      await ctx.reply(
        ['Order placed ✅', '', formatOrder(saved), '', 'Watching for incoming mail…'].join('\n'),
        mainKeyboard(user.accessToken)
      );
    } catch (err) {
      if (err.code === 'INSUFFICIENT_GEMS') {
        await ctx.reply(`Not enough gems. Use /topup.`, mainKeyboard(user.accessToken));
        return;
      }
      await ctx.reply(`Order failed: ${err.message}`);
    }
  });

  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });

  bot.on('successful_payment', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    try {
      const result = await handleTelegramSuccessfulPayment(user.id, ctx.message.successful_payment);
      await ctx.reply(
        `Payment received ✅\n+${formatGems(result.payment.gems)} gems\nBalance: ${formatGems(getUserBalance(user.id))} gems`,
        mainKeyboard(user.accessToken)
      );
    } catch (err) {
      await ctx.reply(`Payment recorded but credit failed: ${err.message}. Contact support with payment ID.`);
    }
  });

  bot.catch((err) => {
    console.error('Telegram bot error:', err);
  });

  return bot;
}

async function launchBot(bot, app) {
  if (!bot) return;

  if (config.webappUrl && config.isProduction) {
    const webhookPath = '/telegram-webhook';
    const webhookUrlFull = `${config.webappUrl}${webhookPath}`;

    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(webhookUrlFull);
    console.log(`Telegram webhook set: ${webhookUrlFull}`);
  } else {
    await bot.launch();
    console.log('Telegram bot running in polling mode (local dev)');
  }
}

module.exports = { createBot, launchBot, webhookUrl };
