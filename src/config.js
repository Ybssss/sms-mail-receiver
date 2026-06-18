require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  webappUrl: (process.env.WEBAPP_URL || '').replace(/\/$/, ''),
  databasePath: process.env.DATABASE_PATH || './data/mail.db',
  isProduction: process.env.NODE_ENV === 'production',

  heroSmsApiKey: process.env.HERO_SMS_API_KEY || '',
  heroSmsBaseUrl: (process.env.HERO_SMS_BASE_URL || 'https://hero-sms.com/api/v1').replace(/\/$/, ''),
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '2000', 10),
  keepAliveIntervalMs: parseInt(process.env.KEEPALIVE_INTERVAL_MS || '600000', 10),
  defaultSite: process.env.DEFAULT_EMAIL_SITE || 'telegram.com',
  defaultDomain: process.env.DEFAULT_EMAIL_DOMAIN || 'gmail.com',
};

function validateConfig() {
  const missing = [];
  if (!config.heroSmsApiKey) missing.push('HERO_SMS_API_KEY');
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (config.isProduction && !config.webappUrl) missing.push('WEBAPP_URL');

  if (missing.length > 0) {
    console.warn(`Warning: missing env vars: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig };
