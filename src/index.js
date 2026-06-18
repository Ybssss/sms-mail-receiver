const { config, validateConfig } = require('./config');
const { getDb } = require('./db/database');
const { createBot, launchBot } = require('./bot/telegram');
const { createWebApp } = require('./web/app');
const { startPollWorker, stopPollWorker } = require('./services/pollWorker');
const { startKeepAlive, stopKeepAlive } = require('./workers/keepAlive');

async function main() {
  validateConfig();
  getDb();

  const app = createWebApp();
  const bot = createBot();

  await launchBot(bot, app);

  startPollWorker();
  startKeepAlive();

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`Hero-SMS poll interval: ${config.pollIntervalMs}ms`);
    console.log(`Keep-alive interval: ${config.keepAliveIntervalMs}ms`);
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
