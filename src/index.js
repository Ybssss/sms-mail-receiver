const { config, validateConfig } = require('./config');
const { getDb } = require('./db/database');
const { createBot, launchBot, setBotInstance } = require('./bot/telegram');
const { createWebApp } = require('./web/app');
const { startPollWorker, stopPollWorker } = require('./services/pollWorker');
const { startKeepAlive, stopKeepAlive } = require('./workers/keepAlive');

async function main() {
  validateConfig();

  const { connectDb } = require('./db/database');
  await connectDb();

  const app = await createWebApp();
  const bot = createBot();
  setBotInstance(bot);

  startPollWorker();
  startKeepAlive();

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`Hero-SMS poll interval: ${config.pollIntervalMs}ms`);
    console.log(`Keep-alive interval: ${config.keepAliveIntervalMs}ms`);
  });

  // Do not await bot launch in local dev: Telegraf's launch() stays pending
  // until the bot stops, and awaiting it would block the HTTP server forever.
  launchBot(bot, app).catch((err) => {
    console.error("Telegram bot launch failed:", err.message);
  });

  process.once('SIGINT', () => {
    stopPollWorker();
    stopKeepAlive();
    bot?.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stopPollWorker();
    stopKeepAlive();
    bot?.stop('SIGTERM');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
