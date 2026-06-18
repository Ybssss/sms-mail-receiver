const { Telegraf, Markup } = require('telegraf');
const { config } = require('../config');
const { orderEmail, cancelEmail, getDomains, getEmail } = require('../services/heroSms');
const {
  getOrCreateTelegramUser,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
} = require('../services/mailStore');
const { setNotifier } = require('../services/notifier');

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
    [Markup.button.callback('📬 Active mail', 'list')],
    [Markup.button.callback('🛒 Order mail', 'order_default')],
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
        'Automated Hero-SMS mail receiver.',
        'Order disposable emails and get codes instantly here or on the web.',
        '',
        'Commands:',
        '/order [site] [domain] — buy email (default from env)',
        '/list — active orders',
        '/mail <id> — order details',
        '/domains — available domains',
        '/cancel <id> — cancel order',
        '/web — web dashboard link',
        '/webhook — webhook URL for Hero-SMS dashboard',
        '/help — help',
        '',
        `Webhook (set in Hero-SMS): ${webhookUrl()}`,
      ].join('\n'),
      mainKeyboard(user.access_token)
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '/order telegram.com gmail.com',
        '/list',
        '/mail 1',
        '/domains',
        '/cancel 1',
        '/web',
        '/webhook',
      ].join('\n')
    );
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
    await ctx.reply(`Web dashboard:\n${webLink(user.access_token)}`, mainKeyboard(user.access_token));
  });

  bot.command('domains', async (ctx) => {
    try {
      const domains = await getDomains();
      const lines = (Array.isArray(domains) ? domains : []).slice(0, 20).map((d) => {
        return `• ${d.name} — cost ${d.cost}, stock ${d.count}`;
      });
      await ctx.reply(lines.length ? lines.join('\n') : 'No domains returned.');
    } catch (err) {
      await ctx.reply(`Hero-SMS error: ${err.message}`);
    }
  });

  bot.command('list', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.reply(formatOrderList(orders), mainKeyboard(user.access_token));
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
      await ctx.reply(formatOrder(updated), mainKeyboard(user.access_token));
    } catch {
      await ctx.reply(formatOrder(order), mainKeyboard(user.access_token));
    }
  });

  bot.command('order', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const parts = ctx.message.text.replace(/^\/order\s*/i, '').trim().split(/\s+/).filter(Boolean);
    const site = parts[0] || config.defaultSite;
    const domain = parts[1] || config.defaultDomain;

    try {
      await ctx.reply(`Ordering ${site} @ ${domain}…`);
      const remote = await orderEmail(site, domain);
      const saved = saveOrder(user.id, remote);
      await ctx.reply(
        ['Order placed ✅', '', formatOrder(saved), '', 'Watching for incoming mail…'].join('\n'),
        mainKeyboard(user.access_token)
      );
    } catch (err) {
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
      await cancelEmail(order.heroId);
      saveOrder(user.id, { ...order, heroId: order.heroId, status: 'CANCELLED' });
      await ctx.reply(`Cancelled order #${id}`, mainKeyboard(user.access_token));
    } catch (err) {
      await ctx.reply(`Cancel failed: ${err.message}`);
    }
  });

  bot.action('list', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    const orders = listOrders(user.id, { limit: 20 });
    await ctx.answerCbQuery();
    await ctx.reply(formatOrderList(orders), mainKeyboard(user.access_token));
  });

  bot.action('order_default', async (ctx) => {
    const user = getOrCreateTelegramUser(ctx.from.id);
    await ctx.answerCbQuery();

    try {
      const remote = await orderEmail(config.defaultSite, config.defaultDomain);
      const saved = saveOrder(user.id, remote);
      await ctx.reply(
        ['Order placed ✅', '', formatOrder(saved), '', 'Watching for incoming mail…'].join('\n'),
        mainKeyboard(user.access_token)
      );
    } catch (err) {
      await ctx.reply(`Order failed: ${err.message}`);
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
