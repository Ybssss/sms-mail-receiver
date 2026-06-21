require("dotenv").config();

function parseAdminIds(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  botUsername: (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, ""),
  webappUrl: (process.env.WEBAPP_URL || "").replace(/\/$/, ""),
  databasePath: process.env.DATABASE_PATH || "./data/mail.db",
  isProduction: process.env.NODE_ENV === "production",

  heroSmsApiKey: process.env.HERO_SMS_API_KEY || "",
  heroSmsBaseUrl: (
    process.env.HERO_SMS_BASE_URL || "https://hero-sms.com/api/v1"
  ).replace(/\/$/, ""),
  webhookSecret: process.env.WEBHOOK_SECRET || "",

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
  keepAliveIntervalMs: parseInt(
    process.env.KEEPALIVE_INTERVAL_MS || "600000",
    10,
  ),
  defaultSite: process.env.DEFAULT_EMAIL_SITE || "telegram.com",
  defaultDomain: process.env.DEFAULT_EMAIL_DOMAIN || "gmail.com",

  // Gems & exchange rate: at USD/MYR=4 → 1 MYR = 10,000 gems; scales dynamically
  baseUsdMyr: parseFloat(process.env.BASE_USD_MYR || "4"),
  baseGemsPerMyr: parseInt(process.env.BASE_GEMS_PER_MYR || "10000", 10),
  exchangeRateCacheMs: parseInt(
    process.env.EXCHANGE_RATE_CACHE_MS || "3600000",
    10,
  ),
  orderMarkupPercent: parseFloat(process.env.ORDER_MARKUP_PERCENT || "20"),
  minOrderGems: parseInt(process.env.MIN_ORDER_GEMS || "1000", 10),
  defaultOrderCostMyr: parseFloat(process.env.DEFAULT_ORDER_COST_MYR || "0.50"),
  minTopupMyr: parseFloat(process.env.MIN_TOPUP_MYR || "5"),

  // Payments: automated Stars by default; Billplz/manual are opt-in
  allowBillplz: process.env.ALLOW_BILLPLZ === "true",
  allowManualPayments: process.env.ALLOW_MANUAL_PAYMENTS === "true",
  allowCreditCard: process.env.ALLOW_CREDIT_CARD === "true",

  // Billplz (FPX, card, TnG, GrabPay via gateway)
  billplzApiKey: process.env.BILLPLZ_API_KEY || "",
  billplzCollectionId: process.env.BILLPLZ_COLLECTION_ID || "",
  billplzXSignatureKey: process.env.BILLPLZ_X_SIGNATURE || "",
  billplzApiUrl: (
    process.env.BILLPLZ_API_URL || "https://www.billplz.com/api"
  ).replace(/\/$/, ""),

  // Telegram Stars
  telegramPaymentProviderToken:
    process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN || "",
  myrPerStar: parseFloat(process.env.MYR_PER_STAR || "0.052"),

  // Manual top-up (settles to your TnG / bank directly)
  manualTngPhone: process.env.MANUAL_TNG_PHONE || "",
  manualTngQrUrl: process.env.MANUAL_TNG_QR_URL || "",
  manualBankName: process.env.MANUAL_BANK_NAME || "",
  manualBankAccount: process.env.MANUAL_BANK_ACCOUNT || "",
  manualBankHolder: process.env.MANUAL_BANK_HOLDER || "",
  manualBankQrUrl: process.env.MANUAL_BANK_QR_URL || "",

  // SMS Activation (SMS-Activate compatible API)
  smsActivateCountry: process.env.SMS_ACTIVATE_COUNTRY || "MY",
  smsActivateCountryId: process.env.SMS_ACTIVATE_COUNTRY_ID || "7",
  smsActivateEnabled: process.env.SMS_ACTIVATE_ENABLED !== "false",

  adminTelegramIds: parseAdminIds(process.env.ADMIN_TELEGRAM_IDS),
};

function validateConfig() {
  const missing = [];
  if (!config.heroSmsApiKey) missing.push("HERO_SMS_API_KEY");
  if (!config.botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (config.isProduction && !config.webappUrl) missing.push("WEBAPP_URL");
  if (
    config.isProduction &&
    !config.telegramPaymentProviderToken &&
    !config.allowBillplz &&
    !config.allowManualPayments
  ) {
    missing.push("TELEGRAM_PAYMENT_PROVIDER_TOKEN");
  }

  if (missing.length > 0) {
    console.warn(`Warning: missing env vars: ${missing.join(", ")}`);
  }
}

module.exports = { config, validateConfig };
