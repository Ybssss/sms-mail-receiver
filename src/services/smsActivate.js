const { config } = require("../config");

const SMS_ACTIVATE_BASE = "https://hero-sms.com/stubs/handler_api.php";

class SmsActivateError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SmsActivateError";
    this.status = status;
  }
}

/**
 * Call the SMS-Activate compatible API.
 * @param {string} action - The action parameter (e.g., "getServicesList", "getNumberV2")
 * @param {object} extraParams - Additional query parameters
 * @returns {any} Parsed API response
 */
async function smsActivateRequest(action, extraParams = {}) {
  if (!config.heroSmsApiKey) {
    throw new SmsActivateError("HERO_SMS_API_KEY is not configured");
  }

  const params = new URLSearchParams({
    apiKey: config.heroSmsApiKey,
    action,
    ...extraParams,
  });

  const url = `${SMS_ACTIVATE_BASE}?${params.toString()}`;
  console.log(`[DEBUG] smsActivateRequest: ${action}`, extraParams);

  const response = await fetch(url);
  const text = await response.text();

  console.log(`[DEBUG] smsActivate response (${action}):`, text.slice(0, 300));

  // The SMS-Activate API returns text/plain responses
  // Error format: "BAD_ACTION", "BAD_KEY", "NO_NUMBERS", etc.
  if (
    text.startsWith("BAD_") ||
    text.startsWith("NO_") ||
    text.startsWith("WRONG_")
  ) {
    throw new SmsActivateError(text, response.status);
  }

  // Try to parse JSON if possible
  try {
    return JSON.parse(text);
  } catch {
    // Return raw text for simple responses like "ACCESS_NUMBER:..."
    return text;
  }
}

/**
 * Get the list of available SMS activation services.
 * @param {string} country - Country ID (e.g., "MY" or country code number)
 * @returns {Array} List of services with code and name
 */
async function getServices(country) {
  const params = {};
  if (country) {
    // SMS-Activate API uses numeric country IDs
    // Common: MY=153, ID=6, US=1, SG=170, TH=14, PH=11, VN=13
    params.country = country;
  }
  const result = await smsActivateRequest("getServicesList", params);

  // If country param fails, try without it
  if (!result?.services && !country) {
    console.log(
      "[DEBUG] getServicesList returned unexpected data, trying without country filter",
    );
    return [];
  }

  if (result?.status === "success" && Array.isArray(result.services)) {
    console.log(`[DEBUG] Found ${result.services.length} SMS services`);
    if (result.services.length > 0) {
      console.log("[DEBUG] First few:", result.services.slice(0, 5));
    }
    return result.services;
  }

  console.log(
    "[DEBUG] Unexpected getServicesList response:",
    JSON.stringify(result).slice(0, 500),
  );
  return [];
}

/**
 * Get current prices for all services in a country.
 * @param {string} service - Optional service code to filter
 * @param {string} country - Country ID
 * @returns {Array} Price data
 */
async function getPrices(service, country) {
  const params = {};
  if (service) params.service = service;
  if (country) params.country = country;

  const result = await smsActivateRequest("getPrices", params);

  // Result format: Array of { "serviceCode": { cost, count, physicalCount } }
  if (Array.isArray(result)) {
    return result;
  }

  return [];
}

/**
 * Get list of countries with country IDs.
 * @returns {Array} List of countries
 */
async function getCountries() {
  const result = await smsActivateRequest("getCountries");
  return result;
}

/**
 * Request a phone number for SMS activation.
 * @param {string} service - Service code (e.g., "oz" for Lazada)
 * @param {string} country - Country ID
 * @param {object} options - Optional params (operator, maxPrice, etc.)
 * @returns {object} { activationId, phoneNumber, activationCost }
 */
async function getNumber(service, country, options = {}) {
  const params = {
    service,
    country,
    ...options,
  };

  const result = await smsActivateRequest("getNumberV2", params);

  if (result?.activationId && result?.phoneNumber) {
    return {
      activationId: result.activationId,
      phoneNumber: result.phoneNumber,
      cost: result.activationCost || 0,
      currency: result.currency || "USD",
      canGetAnotherSms: result.canGetAnotherSms,
      activationTime: result.activationTime,
      activationEndTime: result.activationEndTime,
      operator: result.activationOperator || "any",
    };
  }

  // V1 fallback format: "ACCESS_NUMBER:123456789:79584000000"
  if (typeof result === "string" && result.startsWith("ACCESS_NUMBER:")) {
    const parts = result.split(":");
    return {
      activationId: parts[1],
      phoneNumber: parts[2],
      cost: 0,
      currency: "USD",
      canGetAnotherSms: true,
      operator: "any",
    };
  }

  throw new SmsActivateError(
    typeof result === "string" ? result : JSON.stringify(result),
    400,
  );
}

/**
 * Get activation status.
 * @param {string} activationId
 * @returns {object} { status, smsCode, smsText }
 */
async function getStatus(activationId) {
  const result = await smsActivateRequest("getStatus", {
    id: activationId,
  });

  // Status responses:
  // STATUS_WAIT_CODE - waiting for SMS
  // STATUS_WAIT_RETRY - waiting for retry
  // STATUS_CANCEL - cancelled
  // STATUS_OK:smsCode - SMS received
  if (typeof result === "string") {
    if (result.startsWith("STATUS_OK:")) {
      const code = result.replace("STATUS_OK:", "");
      return { status: "OK", smsCode: code, smsText: "" };
    }
    if (result === "STATUS_WAIT_CODE") {
      return { status: "WAIT_CODE", smsCode: null, smsText: null };
    }
    if (result === "STATUS_WAIT_RETRY") {
      return { status: "WAIT_RETRY", smsCode: null, smsText: null };
    }
    if (result === "STATUS_CANCEL") {
      return { status: "CANCELLED", smsCode: null, smsText: null };
    }
    return { status: "UNKNOWN", smsCode: null, smsText: result };
  }

  return { status: "UNKNOWN", smsCode: null, smsText: JSON.stringify(result) };
}

/**
 * Get all SMS messages for an activation.
 * @param {string} activationId
 * @returns {Array} SMS messages
 */
async function getAllSms(activationId) {
  const result = await smsActivateRequest("getAllSms", {
    id: activationId,
  });

  if (result?.status === "success" && Array.isArray(result.data)) {
    return result.data.map((msg) => ({
      text: msg.text || "",
      code: msg.code || "",
      date: msg.date || "",
    }));
  }

  return [];
}

/**
 * Set activation status (cancel, finish, etc.)
 * @param {string} activationId
 * @param {string} status - Status value (1=ready, 6=complete, 8=cancel)
 * @returns {string} Response text
 */
async function setStatus(activationId, status) {
  const result = await smsActivateRequest("setStatus", {
    id: activationId,
    status,
  });
  return result;
}

/**
 * Get active activations.
 * @returns {Array} Active activations
 */
async function getActiveActivations() {
  const result = await smsActivateRequest("getActiveActivations");

  if (result?.status === "success" && Array.isArray(result.data)) {
    return result.data;
  }

  return [];
}

/**
 * Get service name from service code.
 * Uses API services list or a static fallback map.
 */
const SERVICE_NAMES = {
  oz: "Lazada",
  sp: "Shopee",
  mr: "McDonald's",
  my: "Marrybrown",
  fc: "Foodpanda clone",
  gr: "Grab",
  fb: "Facebook",
  ig: "Instagram",
  wh: "WhatsApp",
  tg: "Telegram",
  go: "Google",
  vk: "VKontakte",
  ok: "Odnoklassniki",
  tw: "Twitter (X)",
  av: "Avito",
  ub: "Uber",
  yc: "Yandex",
  ea: "Ebay",
  al: "Alibaba",
  as: "Aliexpress",
  wb: "Wildberries",
  viber: "Viber",
  line: "LINE",
  kk: "KakaoTalk",
  we: "WeChat",
  ss: "Snapchat",
  dc: "Discord",
  tl: "Telegram",
  tn: "TikTok",
  tb: "Tinder",
  po: "Pof",
  bl: "Badoo",
  mb: "Mamba",
  dr: "DrugVokrug",
  ct: "Citilink",
  ae: "Aeroflot",
  sa: "S7 Airlines",
  ru: "RZD",
  ok: "OK",
  mg: "MEGOGO",
  nl: "Nalog",
  zn: "Znaniya",
  ya: "Yula",
  bp: "Bolt",
  wr: "Wrike",
  tw: "Twitter",
  uk: "UkrPoshta",
  mt: "MTS",
  mv: "MangoOffice",
  kv: "Kufar",
  jv: "JivoSite",
  hr: "Huawei",
  pr: "Prezzocom",
  st: "Steam",
  wm: "Walmart",
  dd: "DODOPizza",
  kp: "KFC",
  bf: "Burger King",
  sb: "Subway",
  pm: "PizzaMasters",
  dp: "Delivery Club",
  iptv: "IPTV",
  mh: "Mihoyo",
  vi: "Viber",
  gp: "Google Play",
  apl: "Apple",
  ms: "Microsoft",
  yn: "Yandex",
};

function getServiceName(code) {
  const name = SERVICE_NAMES[code] || code;
  return name;
}

async function getServicesWithNames(country) {
  const services = await getServices(country);
  return services.map((s) => ({
    ...s,
    displayName: getServiceName(s.code),
  }));
}

module.exports = {
  SmsActivateError,
  smsActivateRequest,
  getServices,
  getPrices,
  getCountries,
  getNumber,
  getStatus,
  getAllSms,
  setStatus,
  getActiveActivations,
  getServiceName,
  getServicesWithNames,
  SERVICE_NAMES,
};
