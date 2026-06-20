const { config } = require("../config");

class HeroSmsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HeroSmsError";
    this.status = status;
  }
}

async function heroRequest(method, path, body) {
  if (!config.heroSmsApiKey) {
    throw new HeroSmsError("HERO_SMS_API_KEY is not configured");
  }

  const url = `${config.heroSmsBaseUrl}${path}`;
  const headers = {
    Accept: "application/json",
    Authorization: config.heroSmsApiKey.startsWith("ApiKey ")
      ? config.heroSmsApiKey
      : `ApiKey ${config.heroSmsApiKey}`,
  };

  const options = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message || data?.error || text || `HTTP ${response.status}`;
    throw new HeroSmsError(message, response.status);
  }

  return data?.data !== undefined ? data.data : data;
}

function normalizeEmailOrder(raw) {
  if (!raw) return null;

  const heroId = String(raw.id ?? raw.emailId ?? raw.activationId ?? "");
  if (!heroId) return null;

  const status = String(raw.status ?? "WAIT").toUpperCase();
  const hasValue = Boolean(raw.value || raw.code);

  return {
    heroId,
    site: raw.site || "",
    domain: raw.domain || "",
    email: raw.email || "",
    status: hasValue && status === "WAIT" ? "RECEIVED" : status,
    value: raw.value || raw.code || null,
    message: raw.message || raw.text || null,
    cost: raw.cost ?? null,
    currency: raw.currency ?? null,
    date: raw.date || raw.receivedAt || null,
  };
}

async function getDomains() {
  const result = await heroRequest("GET", "/emails/domains");
  console.log(
    "[DEBUG] getDomains() raw response:",
    JSON.stringify(result).slice(0, 2000),
  );
  if (Array.isArray(result) && result.length > 0) {
    console.log("[DEBUG] First domain object keys:", Object.keys(result[0]));
    console.log("[DEBUG] First domain object:", JSON.stringify(result[0]));
  }
  return result;
}

async function listActiveEmails() {
  return heroRequest("GET", "/emails");
}

async function getEmail(heroId) {
  const data = await heroRequest("GET", `/emails/${heroId}`);
  return normalizeEmailOrder(data);
}

async function orderEmail(site, domain) {
  const data = await heroRequest("POST", "/emails", { site, domain });
  return normalizeEmailOrder(data);
}

async function cancelEmail(heroId) {
  return heroRequest("DELETE", `/emails/${heroId}`);
}

async function reorderEmail(heroId) {
  return heroRequest("POST", `/emails/${heroId}/reorder`);
}

module.exports = {
  HeroSmsError,
  normalizeEmailOrder,
  getDomains,
  listActiveEmails,
  getEmail,
  orderEmail,
  cancelEmail,
  reorderEmail,
};
