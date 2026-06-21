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
    api_key: config.heroSmsApiKey,
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
  // Country param is optional (numeric ID). If non-numeric, skip it.
  const numericCountry =
    country && !isNaN(Number(country)) ? String(Number(country)) : null;
  const params = {};
  if (numericCountry) {
    params.country = numericCountry;
  }
  console.log("[DEBUG] getServices() params:", params);

  const result = await smsActivateRequest("getServicesList", params);

  if (result?.status === "success" && Array.isArray(result.services)) {
    console.log(`[DEBUG] Found ${result.services.length} SMS services`);
    if (result.services.length > 0) {
      console.log("[DEBUG] First few:", result.services.slice(0, 5));
    }
    return result.services;
  }

  // If filtered by country and got nothing, retry without country
  if (numericCountry) {
    console.log(
      "[DEBUG] getServicesList with country returned nothing, retrying without filter",
    );
    const retry = await smsActivateRequest("getServicesList", {});
    if (retry?.status === "success" && Array.isArray(retry.services)) {
      console.log(`[DEBUG] Retry found ${retry.services.length} services`);
      return retry.services;
    }
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
  // getPrices requires numeric country ID, not alpha-2 code
  // Use default Malaysia (153) when no country specified
  if (!country || country === "" || country === "undefined") {
    console.log(
      "[DEBUG] getPrices no country provided, defaulting to 153 (Malaysia)",
    );
    params.country = "153";
  } else {
    const numericCountry = !isNaN(Number(country))
      ? String(Number(country))
      : null;
    if (numericCountry && numericCountry !== "NaN") {
      params.country = numericCountry;
    } else {
      // Non-numeric country code — fall back to default
      console.log(
        "[DEBUG] getPrices got non-numeric country:",
        country,
        "falling back to 153",
      );
      params.country = "153";
    }
  }

  const result = await smsActivateRequest("getPrices", params);

  // Handle raw JSON text response: {"oz":{"oz":"0.15","count":100}, ...}
  if (typeof result === "string" && result.trim()) {
    try {
      const parsed = JSON.parse(result);
      console.log("[DEBUG] getPrices parsed JSON object keys count:", Object.keys(parsed).length);
      const prices = [];
      for (const [code, data] of Object.entries(parsed)) {
        if (typeof data === "object" && data !== null) {
          // Find cost: first try data[code], then look for any numeric string value
          let cost = data[code] || data.cost;
          if (cost === undefined || cost === null) {
            // Try finding any value that looks like a price (e.g. "0.15")
            const entries = Object.entries(data);
            for (const [k, v] of entries) {
              if (k !== "count" && k !== "physicalCount" && typeof v === "string" && !isNaN(Number(v))) {
                cost = v;
                break;
              }
            }
          }
          const count = data.count ?? 0;
          const physicalCount = data.physicalCount ?? 0;
          prices.push({ [code]: { cost: Number(cost || 0), count: Number(count), physicalCount: Number(physicalCount) } });
        }
      }
      console.log("[DEBUG] getPrices parsed", prices.length, "price entries");
      if (prices.length > 0) return prices;
    } catch (e) {
      console.log("[DEBUG] getPrices JSON parse error:", e.message);
    }
  }

  // Result might be an array: [{ "oz": { cost: 0.15, count: 100 } }, ...]
  if (Array.isArray(result)) {
    console.log("[DEBUG] getPrices returned array of", result.length);
    if (result.length > 0) return result;
  }

  // Maybe wrapped in status object
  if (result?.status === "success" && result.data) {
    console.log("[DEBUG] getPrices wrapped in status object, data is", typeof result.data);
    return Array.isArray(result.data) ? result.data : [];
  }

  // Plain object. API format: {"7": {"sp": {"cost":0.05,"count":100}, ...}}
  // Top-level key is country ID; inner object maps service codes to price data.
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const keys = Object.keys(result);
    console.log("[DEBUG] getPrices returned plain object, keys:", keys.length);
    // Determine if the first value looks like a nested price map
    const firstVal = result[keys[0]];
    if (firstVal && typeof firstVal === "object" && !Array.isArray(firstVal)) {
      const innerKeys = Object.keys(firstVal);
      if (innerKeys.length > 0 && firstVal[innerKeys[0]] && typeof firstVal[innerKeys[0]] === "object" && firstVal[innerKeys[0]].cost !== undefined) {
        // Nested format: result is {countryId: {serviceCode: {cost, count}}}
        console.log("[DEBUG] getPrices detected nested country->service format, inner keys:", innerKeys.length);
        const prices = [];
        for (const [code, data] of Object.entries(firstVal)) {
          prices.push({ [code]: { cost: Number(data.cost || 0), count: Number(data.count || 0), physicalCount: Number(data.physicalCount || 0) } });
        }
        return prices;
      }
    }
    // Flat format: {serviceCode: {cost, count, ...}}
    console.log("[DEBUG] getPrices treating as flat service->price format");
    const prices = [];
    for (const [code, data] of Object.entries(result)) {
      if (typeof data === "object" && data !== null && data.cost !== undefined) {
        prices.push({ [code]: { cost: Number(data.cost || 0), count: Number(data.count || 0), physicalCount: Number(data.physicalCount || 0) } });
      }
    }
    if (prices.length > 0) return prices;
  }

  console.log(
    "[DEBUG] getPrices unexpected format:",
    typeof result,
    JSON.stringify(result).slice(0, 500),
  );
  return [];
}

/**
 * Get list of countries with country IDs.
 * @returns {Array} List of countries
 */
async function getCountries() {
  const result = await smsActivateRequest("getCountries");
  // API returns object with numeric IDs as keys: {"1":{id:1,eng:"Ukraine",...}, "2":{...}}
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const list = Object.values(result);
    console.log(
      `[DEBUG] getCountries: ${list.length} countries from object, first:`,
      list[0],
    );
    return list;
  }
  // Also handle array format
  if (Array.isArray(result)) {
    console.log(
      `[DEBUG] getCountries: ${result.length} countries from array, first:`,
      result[0],
    );
    return result;
  }
  if (result?.status === "success" && Array.isArray(result.countries)) {
    return result.countries;
  }
  if (result?.status === "success" && Array.isArray(result.data)) {
    return result.data;
  }
  console.log(
    "[DEBUG] getCountries unexpected format:",
    typeof result,
    JSON.stringify(result).slice(0, 300),
  );
  return [];
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
/**
 * Get account balance from the SMS-Activate API.
 * @returns {object} { balance, currency }
 */
async function getBalance() {
  const result = await smsActivateRequest("getBalance");
  // Returns text like "ACCESS_BALANCE:123.45" or JSON
  if (typeof result === "string" && result.startsWith("ACCESS_BALANCE:")) {
    const balance = parseFloat(result.replace("ACCESS_BALANCE:", "")) || 0;
    return { balance, currency: "USD" };
  }
  if (result?.balance) return result;
  return { balance: 0, currency: "USD" };
}

/**
 * Get top countries for a specific service (best prices/stock).
 * @param {string} service - Service code (e.g., "oz" for Lazada)
 * @returns {Array} Top countries with price info
 */
async function getTopCountriesByService(service) {
  const result = await smsActivateRequest("getTopCountriesByService", {
    service,
  });
  if (Array.isArray(result)) return result;
  if (result?.status === "success" && Array.isArray(result.data))
    return result.data;
  return [];
}

/**
 * Get rental services and available countries.
 * @returns {object} Rental services and countries
 */
async function getRentServicesAndCountries() {
  const result = await smsActivateRequest("getRentServicesAndCountries");
  if (result?.status === "success") return result;
  return { services: [], countries: [] };
}

/**
 * Request a number for rental (long-term).
 * @param {string} service - Service code
 * @param {string} country - Country ID
 * @returns {object} { activationId, phoneNumber, cost }
 */
async function getRentNumber(service, country) {
  const result = await smsActivateRequest("getRentNumber", {
    service,
    country,
  });
  if (result?.activationId && result?.phoneNumber) {
    return {
      activationId: result.activationId,
      phoneNumber: result.phoneNumber,
      cost: result.activationCost || 0,
    };
  }
  if (typeof result === "string" && result.startsWith("ACCESS_NUMBER:")) {
    const parts = result.split(":");
    return { activationId: parts[1], phoneNumber: parts[2], cost: 0 };
  }
  throw new SmsActivateError(
    typeof result === "string" ? result : JSON.stringify(result),
    400,
  );
}

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

function getServiceName(code, apiName) {
  // Use the API's actual name if available, otherwise fallback to static map or code
  if (apiName && apiName !== code) return apiName;
  return SERVICE_NAMES[code] || code;
}

async function getServicesWithNames(country) {
  const services = await getServices(country);
  return services.map((s) => ({
    ...s,
    displayName: getServiceName(s.code, s.name),
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
  getBalance,
  getTopCountriesByService,
  getRentServicesAndCountries,
  getRentNumber,
  getServiceName,
  getServicesWithNames,
  SERVICE_NAMES,
};
