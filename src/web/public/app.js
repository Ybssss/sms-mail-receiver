const STORAGE_KEY = "hero_mail_token";
// ── Wait for Telegram initData (iOS may have delay) ────────────
function waitForInitData(maxAttempts = 6, delay = 400) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      if (tgWebApp?.initData) {
        resolve(true);
        return;
      }
      if (attempts >= maxAttempts) {
        resolve(false);
        return;
      }
      setTimeout(check, delay);
    };
    check();
  });
}
let token = "";
let pollTimer = null;
let refreshMs = 2000;
let wallet = null;
let domainList = [];
let smsServiceList = [];
let smsCountryList = [];
let smsSelectedCountry = "";
let tgWebApp = null;
let userCountryCode = ""; // from Telegram initData

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const orderForm = $("order-form");
const serviceSelect = $("service-select");
const smsServiceSelect = $("sms-service-select");
const smsCountrySelect = $("sms-country-select");
const smsSearchInput = $("sms-service-search");
const smsOrderForm = $("sms-order-form");
const smsResult = $("sms-result");
const smsError = $("sms-error");
const smsSummary = $("sms-summary");
const ordersList = $("orders-list");
const emptyState = $("empty-state");
const liveStatus = $("live-status");
const pollIntervalEl = $("poll-interval");
const pollIntervalMs = $("poll-interval-ms");
const gemsBalanceEl = $("gems-balance");
const gemsPerMyrEl = $("gems-per-myr");
const topupMethodSelect = $("topup-method");
const customMyrInput = $("custom-myr");
const customTopupBtn = $("custom-topup-btn");
const topupResult = $("topup-result");
const topupConfirmSection = $("topup-confirm-section");
const paymentProofInput = $("payment-proof-input");
const confirmPaymentBtn = $("confirm-payment-btn");
const confirmPaymentResult = $("confirm-payment-result");
const orderCostHint = $("order-cost-hint");
const serviceError = $("service-error");
const refreshBtn = $("refresh-btn");
const tokenPanel = $("token-panel");
const tokenInput = $("token-input");
const tokenSave = $("token-save");
const telegramLink = $("telegram-link");

let lastPaymentId = null;

// ── Telegram WebApp ──────────────────────────────────────────────
function initTelegramWebApp() {
  tgWebApp = window.Telegram?.WebApp;
  if (!tgWebApp?.initData) return false;

  try {
    tgWebApp.ready();
    tgWebApp.expand();

    const theme = tgWebApp.themeParams || {};
    const root = document.documentElement;
    if (theme.bg_color) root.style.setProperty("--bg", theme.bg_color);
    if (theme.secondary_bg_color)
      root.style.setProperty("--surface", theme.secondary_bg_color);
    if (theme.text_color) root.style.setProperty("--text", theme.text_color);
    if (theme.hint_color) root.style.setProperty("--muted", theme.hint_color);
    if (theme.button_color)
      root.style.setProperty("--accent-strong", theme.button_color);
    if (theme.link_color) root.style.setProperty("--accent", theme.link_color);

    document.body.classList.add("in-telegram");

    // Detect user country from Telegram initData
    if (tgWebApp.initDataUnsafe?.user?.language_code) {
      const lang = tgWebApp.initDataUnsafe.user.language_code;
      const parts = lang.split("-");
      if (parts.length > 1) userCountryCode = parts[1].toUpperCase();
    }

    return true;
  } catch (e) {
    console.warn("Telegram WebApp init failed:", e.message);
    return false;
  }
}

async function authFromTelegram() {
  if (!tgWebApp?.initData) {
    console.log("[AUTH] No Telegram initData available — skipping auth");
    return false;
  }
  if (!tgWebApp?.initData) {
    console.log(
      "[AUTH] No Telegram initData available — not in Telegram WebView",
    );
    return false;
  }
  console.log(
    "[AUTH] Attempting Telegram auth, initData length:",
    tgWebApp.initData.length,
  );
  console.log(
    "[AUTH] initData preview (first 200 chars):",
    tgWebApp.initData.substring(0, 200),
  );
  console.log(
    "[AUTH] initDataUnsafe:",
    JSON.stringify({
      hasUser: !!tgWebApp.initDataUnsafe?.user,
      userId: tgWebApp.initDataUnsafe?.user?.id,
      firstName: tgWebApp.initDataUnsafe?.user?.first_name,
      language_code: tgWebApp.initDataUnsafe?.user?.language_code,
    }),
  );

  try {
    const response = await fetch("/api/telegram-auth", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: tgWebApp.initData,
    });

    console.log("[AUTH] Server response status:", response.status);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error(
        "[AUTH] Telegram auth failed:",
        response.status,
        errData.error || response.statusText,
      );
      console.log("[AUTH] Error details:", JSON.stringify(errData));
      return false;
    }

    const data = await response.json();
    console.log(
      "[AUTH] Telegram auth success, user:",
      data.telegramId,
      data.firstName,
    );
    console.log(
      "[AUTH] Received token:",
      data.token ? data.token.substring(0, 8) + "..." : "NONE",
    );
    setToken(data.token);
    tokenPanel.hidden = true;

    if (data.firstName) {
      const subtitle = document.querySelector(".subtitle");
      if (subtitle)
        subtitle.textContent = `Hi ${data.firstName} — top up gems, order SMS numbers, receive codes instantly.`;
    }
    return true;
  } catch (e) {
    console.error("[AUTH] Telegram auth network error:", e.message, e.stack);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function fmt(n) {
  return Number(n).toLocaleString("en-MY");
}

function fmtSeconds(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

function setToken(nextToken) {
  token = nextToken;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {}
  if (tokenPanel) tokenPanel.hidden = Boolean(token);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data;
}

// ── Wallet ───────────────────────────────────────────────────────
function renderWallet(w) {
  wallet = w;
  gemsBalanceEl.textContent = `💎 ${fmt(w.balance)} gems`;
  gemsPerMyrEl.textContent = fmt(w.exchange.gemsPerMyr);

  topupMethodSelect.innerHTML = "";
  w.methods.forEach((m) => {
    if (m.id === "telegram_stars") return;
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    topupMethodSelect.appendChild(opt);
  });

  if (topupMethodSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Top Up Temporarily Unavailable";
    opt.disabled = true;
    topupMethodSelect.appendChild(opt);
  }

  const feeHint = $("processing-fee-hint");
  if (feeHint) {
    const hasBillplz = w.methods.some((m) => m.id === "billplz");
    feeHint.classList.toggle("hidden", !hasBillplz);
  }
}

async function loadWallet() {
  const w = await api("/api/wallet");
  renderWallet(w);
}

// ── Email Activation ─────────────────────────────────────────────
function renderServices(domains) {
  domainList = domains;
  serviceSelect.innerHTML = '<option value="">Select a service...</option>';
  if (serviceError) serviceError.classList.add("hidden");

  if (!domains || domains.length === 0) {
    serviceSelect.innerHTML = '<option value="">No services available</option>';
    if (orderCostHint)
      orderCostHint.textContent = "No services returned from provider.";
    return;
  }

  domains.forEach((d) => {
    const name = d.name || d.domain;
    const count = d.count != null ? d.count : "?";
    const opt = document.createElement("option");
    opt.value = name;
    opt.dataset.site = d.site || d.name || d.domain || "";
    opt.dataset.domain = d.domain || d.name || "";
    opt.textContent = `${name} — ${fmt(d.costGems)} gems (stock: ${count})`;
    serviceSelect.appendChild(opt);
  });
  updateOrderCostHint();
}

function updateOrderCostHint() {
  if (!orderCostHint) return;
  const selected = serviceSelect.value;
  if (!selected) {
    orderCostHint.textContent = "Select a service to see gem cost.";
    return;
  }
  const domain = domainList.find((d) => (d.name || d.domain) === selected);
  orderCostHint.textContent = domain
    ? `Cost: ${fmt(domain.costGems)} gems`
    : "Select a service to see gem cost.";
}

async function createOrder(event) {
  event.preventDefault();
  const selected = serviceSelect.value;
  if (!selected) return;

  const submitBtn = orderForm.querySelector("button");
  submitBtn.disabled = true;
  submitBtn.textContent = "Ordering…";

  try {
    const domain = domainList.find((d) => (d.name || d.domain) === selected);
    const site = (domain?.site || domain?.name || domain?.domain || "").trim();
    const dom = (domain?.domain || domain?.name || "").trim();
    if (!site) throw new Error("Invalid service");
    if (!dom) throw new Error("Invalid domain");

    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ site, domain: dom }),
    });
    await loadOrders();
    await loadWallet();
  } catch (err) {
    // Instant warning for insufficient gems
    if (err.message.includes("Insufficient gems")) {
      showWarning(
        err.message + "\n\n💡 Top up gems first using the section above.",
      );
    } else {
      liveStatus.textContent = err.message;
      liveStatus.className = "status-pill error";
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Order now";
  }
}

// ── Warning toast ─────────────────────────────────────────────────
function showWarning(message, duration = 5000) {
  let toast = document.getElementById("warning-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "warning-toast";
    toast.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#fbbf24;color:#000;padding:14px 20px;border-radius:12px;font-weight:600;z-index:2000;max-width:90%;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.display = "block";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.display = "none";
  }, duration);
  // Also scroll to topup panel
  $("topup-panel")?.scrollIntoView({ behavior: "smooth" });
}

// ── SMS Activation ───────────────────────────────────────────────
function renderSmsCountries(countries) {
  if (!smsCountrySelect) return;
  smsCountrySelect.innerHTML = '<option value="">All countries</option>';
  if (!Array.isArray(countries) || !countries.length) {
    console.warn("No SMS countries returned from API");
    return;
  }
  smsCountryList = countries;

  // Sort: user's Telegram country first, then by name
  const sorted = [...countries].sort((a, b) => {
    const aMatch =
      a.id === userCountryCode ||
      (a.eng || "").toUpperCase().includes(userCountryCode);
    const bMatch =
      b.id === userCountryCode ||
      (b.eng || "").toUpperCase().includes(userCountryCode);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return (a.eng || "").localeCompare(b.eng || "");
  });

  sorted.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.eng || c.rus || `Country ${c.id}`;
    smsCountrySelect.appendChild(opt);
  });

  if (smsSelectedCountry) {
    smsCountrySelect.value = smsSelectedCountry;
  } else {
    // Auto-select Malaysia by default if not already selected
    const malaysiaOpt = Array.from(smsCountrySelect.options).find((o) =>
      o.textContent.includes("Malaysia"),
    );
    if (malaysiaOpt) {
      smsSelectedCountry = malaysiaOpt.value;
      smsCountrySelect.value = malaysiaOpt.value;
      // Trigger price load for default country
      loadSmsPricesForCountry(smsSelectedCountry);
    }
  }
}

if (smsCountrySelect) {
  smsCountrySelect.addEventListener("change", async () => {
    smsSelectedCountry = smsCountrySelect.value;
    if (smsSelectedCountry) {
      await loadSmsPricesForCountry(smsSelectedCountry);
    } else {
      await loadSmsServices();
    }
  });
}

async function loadSmsPricesForCountry(countryId) {
  if (!smsServiceSelect || !smsSearchInput) return;

  smsServiceSelect.innerHTML = '<option value="">Loading prices...</option>';
  smsServiceSelect.disabled = true;
  smsSearchInput.placeholder = `Loading prices...`;
  if (smsSummary) smsSummary.classList.add("hidden");

  try {
    const data = await api(`/api/sms-services?country=${countryId}`);
    if (data.currentCountryId) {
      smsSelectedCountry = String(data.currentCountryId);
      smsCountrySelect.value = smsSelectedCountry;
    }
    renderSmsServices(data.services);
  } catch (err) {
    console.error("Failed to load prices for country:", countryId, err.message);
    // Keep existing services but show error hint
    if (smsServiceSelect && smsServiceList.length > 0) {
      populateSmsDropdown(); // Show existing list
    } else {
      smsServiceSelect.innerHTML =
        '<option value="">Failed to load prices</option>';
    }
    if (smsError) {
      smsError.textContent =
        "Could not load prices for this country. Showing cached data.";
      smsError.classList.remove("hidden");
    }
  } finally {
    if (smsServiceSelect) smsServiceSelect.disabled = false;
  }
}

async function loadSmsServices() {
  try {
    const data = await api("/api/sms-services");
    if (data.currentCountryId) {
      smsSelectedCountry = String(data.currentCountryId);
      if (smsCountrySelect) smsCountrySelect.value = smsSelectedCountry;
    }
    renderSmsServices(data.services);
  } catch (err) {
    console.error("SMS services load error:", err.message);
    if (smsError) {
      smsError.textContent = "SMS services unavailable: " + err.message;
      smsError.classList.remove("hidden");
    }
  }
}

function renderSmsServices(services) {
  if (!smsServiceSelect) return;
  smsServiceList = services || [];
  if (smsError) smsError.classList.add("hidden");
  if (smsResult) smsResult.textContent = "";
  if (smsSummary) smsSummary.classList.add("hidden");

  populateSmsDropdown();

  if (smsSearchInput) {
    smsSearchInput.placeholder = `Search ${services?.length || 0} services...`;
    smsSearchInput.disabled = false;
  }
}

function populateSmsDropdown(filter) {
  if (!smsServiceSelect) return;
  const query = (filter || smsSearchInput?.value || "").toLowerCase().trim();

  smsServiceSelect.innerHTML = query
    ? ""
    : '<option value="">Select a service...</option>';

  const filtered = query
    ? smsServiceList.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.code.toLowerCase().includes(query),
      )
    : smsServiceList;

  if (!filtered.length) {
    smsServiceSelect.innerHTML = `<option value="">${query ? `No match for "${query}"` : "No SMS services available"}</option>`;
    return;
  }

  // Auto-select best match when typing
  if (query && filtered.length > 0) {
    smsServiceSelect.innerHTML =
      '<option value="">Select a service...</option>';
  }

  filtered.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.code;
    const priceGems = s.costGems ? fmt(s.costGems) : "?";
    const stock = s.stock || "?";
    opt.textContent = `${s.name} — ${priceGems} gems (stock: ${stock})`;
    smsServiceSelect.appendChild(opt);
  });

  // Auto-select the first match if there's an active search query
  if (query && filtered.length > 0) {
    // Always show all matches in dropdown, user picks
    const bestMatch = smsServiceSelect.options[1]; // skip "Select a service"
    if (bestMatch) bestMatch.selected = true;
  }
}

// Show summary when service selected
if (smsServiceSelect) {
  smsServiceSelect.addEventListener("change", () => {
    const selected = smsServiceSelect.value;
    if (!selected || !smsSummary) return;
    const svc = smsServiceList.find((s) => s.code === selected);
    if (svc) {
      const priceGems = svc.costGems
        ? fmt(svc.costGems)
        : svc.costUsd
          ? `$${svc.costUsd.toFixed(2)}`
          : "?";
      const stock = svc.stock || "?";
      const countryName =
        smsCountrySelect?.selectedOptions[0]?.textContent || "selected country";
      smsSummary.innerHTML = `<strong>${svc.name}</strong> — ${priceGems} gems · ${stock} numbers · 🌍 ${countryName}`;
      smsSummary.classList.remove("hidden");
    }
  });
}

// Live search
if (smsSearchInput) {
  smsSearchInput.addEventListener("input", () => {
    populateSmsDropdown(smsSearchInput.value);
    // Show summary hint for matched service
    if (smsSummary) {
      const query = smsSearchInput.value.toLowerCase().trim();
      const match = smsServiceList.find(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.code.toLowerCase().includes(query),
      );
      if (match && query.length >= 2) {
        const priceGems = match.costGems
          ? fmt(match.costGems)
          : match.costUsd
            ? `$${match.costUsd.toFixed(2)}`
            : "?";
        smsSummary.innerHTML = `<strong>Best match:</strong> ${match.name} — ${priceGems} gems · stock: ${match.stock || "?"}`;
        smsSummary.classList.remove("hidden");
      } else if (!smsServiceSelect.value) {
        smsSummary.classList.add("hidden");
      }
    }
  });
}

async function createSmsOrder(event) {
  event.preventDefault();
  if (!smsServiceSelect) return;
  const selected = smsServiceSelect.value;
  if (!selected) return;

  const submitBtn = smsOrderForm.querySelector("button");
  submitBtn.disabled = true;
  submitBtn.textContent = "Ordering SMS...";
  if (smsResult) smsResult.textContent = "Requesting SMS number...";
  if (smsError) smsError.classList.add("hidden");

  try {
    const countryId = smsCountrySelect?.value || "";
    const result = await api("/api/sms/order", {
      method: "POST",
      body: JSON.stringify({ service: selected, country: countryId }),
    });

    const service = smsServiceList.find((s) => s.code === selected);
    const lines = [
      "✅ SMS Number Ordered!",
      `Service: ${result.serviceName || service?.name || selected}`,
      `Phone: ${result.phoneNumber}`,
      `Cost: ${result.costGems.toLocaleString()} gems`,
      `Expires: ${result.activationEndTime ? new Date(result.activationEndTime).toLocaleString() : "N/A"}`,
      "",
      `Activation ID: ${result.activationId}`,
    ];

    if (smsResult) {
      smsResult.textContent = lines.join("\n");
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "btn-secondary";
      checkBtn.textContent = "🔄 Check SMS Code";
      checkBtn.dataset.activationId = result.activationId;
      checkBtn.addEventListener("click", () =>
        checkSmsCode(result.activationId),
      );
      smsResult.after(checkBtn);
    }
  } catch (err) {
    // Instant warning for insufficient gems
    if (err.message.includes("Insufficient gems")) {
      showWarning(
        err.message + "\n\n💡 Top up gems first using the section above.",
      );
    } else {
      if (smsError) {
        smsError.textContent = err.message;
        smsError.classList.remove("hidden");
      }
    }
    if (smsResult) smsResult.textContent = "";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Order SMS";
  }
}

async function checkSmsCode(activationId) {
  try {
    const status = await api(`/api/sms/status/${activationId}`);
    const msgEl = document.createElement("p");
    msgEl.className = "hint";
    const statusText =
      status.status === "OK"
        ? `✅ Code received: ${status.smsCode}`
        : `⏳ Status: ${status.status}${status.messages?.length ? ` - ${status.messages[0]?.text || ""}` : ""}`;
    msgEl.textContent = statusText;
    if (smsResult) smsResult.after(msgEl);
  } catch (err) {
    if (smsError) {
      smsError.textContent = "Check failed: " + err.message;
      smsError.classList.remove("hidden");
    }
  }
}

// Check code on a specific card and update it in-place
async function checkSmsCodeOnCard(card, activationId) {
  if (!card || !activationId) return;
  try {
    const status = await api(`/api/sms/status/${activationId}`);
    if (status.status === "OK" && status.smsCode) {
      // Update the card to show received code
      card.classList.add("received");
      const statusEl = card.querySelector(".order-status");
      if (statusEl) {
        statusEl.classList.add("received");
        statusEl.textContent = "CODE RECEIVED";
      }
      // Add code display with copy button
      const existingCode = card.querySelector(".order-value");
      if (!existingCode) {
        const codeRow = document.createElement("div");
        codeRow.className = "order-value";
        codeRow.style.display = "flex";
        codeRow.style.alignItems = "center";
        codeRow.style.gap = "8px";

        const codeText = document.createElement("span");
        codeText.textContent = `📨 Code: ${status.smsCode}`;
        codeText.style.flex = "1";

        const copyCodeBtn = document.createElement("button");
        copyCodeBtn.type = "button";
        copyCodeBtn.className = "btn-secondary";
        copyCodeBtn.textContent = "📋 Copy";
        copyCodeBtn.style.padding = "4px 10px";
        copyCodeBtn.style.fontSize = "0.8rem";
        copyCodeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          navigator.clipboard
            .writeText(status.smsCode)
            .then(() => {
              copyCodeBtn.textContent = "✅ Copied";
              setTimeout(() => {
                copyCodeBtn.textContent = "📋 Copy";
              }, 1500);
            })
            .catch(() => {});
        });

        codeRow.append(codeText, copyCodeBtn);
        card.appendChild(codeRow);
      }
      // Remove "Check Code" button since code is received
      const actions = card.querySelector(".order-actions");
      if (actions) actions.remove();
    } else {
      // Show waiting status flash on the card
      const statusEl = card.querySelector(".order-status");
      if (statusEl) {
        statusEl.textContent = status.status || "WAITING";
        setTimeout(() => {
          if (statusEl.textContent !== "CODE RECEIVED") {
            statusEl.textContent = "WAIT_CODE";
          }
        }, 2000);
      }
      // Show any SMS text if available
      if (status.messages?.length) {
        const msgEl = document.createElement("div");
        msgEl.className = "order-meta";
        msgEl.textContent =
          status.messages
            .map((m) => m.text || m.code)
            .filter(Boolean)
            .join(" · ") || "Waiting...";
        const existingMsg = card.querySelector(".check-msg");
        if (existingMsg) existingMsg.remove();
        msgEl.className += " check-msg";
        card.appendChild(msgEl);
        setTimeout(() => {
          if (msgEl.parentNode) msgEl.remove();
        }, 10000);
      }
    }
  } catch (err) {
    console.error("checkSmsCodeOnCard error:", err.message);
  }
}

// Auto-poll SMS activations for codes (runs every refresh cycle)
async function autoPollSmsCodes() {
  const cards = ordersList.querySelectorAll(
    ".order-card[data-activation-id]:not(.received)",
  );
  for (const card of cards) {
    const activationId = card.dataset.activationId;
    if (activationId) {
      checkSmsCodeOnCard(card, activationId).catch(() => {});
    }
  }
}

// ── Orders ───────────────────────────────────────────────────────
function renderOrders(orders, smsActivations = []) {
  ordersList.innerHTML = "";

  // Render email orders
  orders.forEach((order) => {
    const card = document.createElement("article");
    card.className = `order-card${order.value ? " received" : ""}`;

    const top = document.createElement("div");
    top.className = "order-top";
    const email = document.createElement("div");
    email.className = "order-email";
    email.textContent =
      order.email || `${order.domain || order.site} (pending)`;
    const status = document.createElement("span");
    status.className = `order-status${order.value ? " received" : ""}`;
    status.textContent = order.value ? "RECEIVED" : order.status;
    top.append(email, status);

    const meta = document.createElement("div");
    meta.className = "order-meta";
    const gemsPart = order.gemsCharged
      ? ` · ${fmt(order.gemsCharged)} gems`
      : "";
    meta.textContent = `📧 #${order.id} · ${order.site || ""} · ${order.domain || ""}${gemsPart}`;
    card.append(top, meta);

    if (order.value) {
      const val = document.createElement("div");
      val.className = "order-value";
      val.textContent = order.value;
      card.appendChild(val);
    }
    if (order.message) {
      const msg = document.createElement("div");
      msg.className = "order-meta";
      msg.textContent = order.message;
      card.appendChild(msg);
    }
    if (!order.value && order.status !== "CANCELLED") {
      const actions = document.createElement("div");
      actions.className = "order-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "cancel-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => cancelOrder(order.id));
      actions.appendChild(cancelBtn);
      card.appendChild(actions);
    }
    ordersList.appendChild(card);
  });

  // Render SMS activations
  smsActivations.forEach((a) => {
    const card = document.createElement("article");
    card.className = `order-card${a.smsCode ? " received" : ""}`;
    card.dataset.activationId = a.activationId;

    const top = document.createElement("div");
    top.className = "order-top";

    // Phone number with click-to-copy
    const phoneEl = document.createElement("div");
    phoneEl.className = "order-email copyable";
    phoneEl.textContent = a.phoneNumber || "N/A";
    phoneEl.title = "Click to copy phone number";
    phoneEl.style.cursor = "pointer";
    phoneEl.addEventListener("click", () => {
      const phone = a.phoneNumber || "";
      if (!phone) return;
      navigator.clipboard
        .writeText(phone)
        .then(() => {
          const orig = phoneEl.textContent;
          phoneEl.textContent = "📋 Copied!";
          setTimeout(() => {
            phoneEl.textContent = orig;
          }, 1500);
        })
        .catch(() => {
          // Fallback for non-HTTPS
          const ta = document.createElement("textarea");
          ta.value = phone;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          const orig = phoneEl.textContent;
          phoneEl.textContent = "📋 Copied!";
          setTimeout(() => {
            phoneEl.textContent = orig;
          }, 1500);
        });
    });

    const status = document.createElement("span");
    status.className = `order-status${a.smsCode ? " received" : ""}`;
    status.textContent = a.smsCode ? "CODE RECEIVED" : a.status || "WAIT_CODE";
    top.append(phoneEl, status);

    // Service & cost line
    const meta = document.createElement("div");
    meta.className = "order-meta";
    meta.textContent = `📱 SMS · ${a.serviceName || a.service} · ${fmt(a.costGems)} gems`;
    card.append(top, meta);

    // Timer
    if (a.activationTime) {
      const timer = document.createElement("div");
      timer.className = "order-meta timer-line";
      const endTime = new Date(a.activationTime).getTime();
      const updateTimer = () => {
        const remaining = Math.max(0, endTime - Date.now());
        if (remaining <= 0) {
          timer.textContent = "⏰ Expired";
          return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        timer.textContent = `⏳ Expires in: ${m}m ${s}s`;
      };
      updateTimer();
      const timerInterval = setInterval(updateTimer, 1000);
      card._timerInterval = timerInterval;
      card.appendChild(timer);
    }

    if (a.activationId) {
      const meta2 = document.createElement("div");
      meta2.className = "order-meta";
      meta2.textContent = `ID: ${a.activationId}`;
      card.appendChild(meta2);
    }

    // Show received code with copy button
    if (a.smsCode) {
      const codeRow = document.createElement("div");
      codeRow.className = "order-value";
      codeRow.style.display = "flex";
      codeRow.style.alignItems = "center";
      codeRow.style.gap = "8px";

      const codeText = document.createElement("span");
      codeText.textContent = `📨 Code: ${a.smsCode}`;
      codeText.style.flex = "1";

      const copyCodeBtn = document.createElement("button");
      copyCodeBtn.type = "button";
      copyCodeBtn.className = "btn-secondary";
      copyCodeBtn.textContent = "📋 Copy";
      copyCodeBtn.style.padding = "4px 10px";
      copyCodeBtn.style.fontSize = "0.8rem";
      copyCodeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(a.smsCode)
          .then(() => {
            copyCodeBtn.textContent = "✅ Copied";
            setTimeout(() => {
              copyCodeBtn.textContent = "📋 Copy";
            }, 1500);
          })
          .catch(() => {});
      });

      codeRow.append(codeText, copyCodeBtn);
      card.appendChild(codeRow);
    }

    // Actions
    if (!a.smsCode) {
      const actions = document.createElement("div");
      actions.className = "order-actions";

      // 检查按钮
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "btn-secondary";
      checkBtn.textContent = "🔄 Check Code";
      checkBtn.addEventListener("click", () =>
        checkSmsCodeOnCard(card, a.activationId),
      );
      actions.appendChild(checkBtn);

      // 取消按钮
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "cancel-btn";
      cancelBtn.textContent = "❌ Cancel";
      cancelBtn.style.marginLeft = "8px";
      cancelBtn.addEventListener("click", () =>
        cancelSmsActivation(a.activationId, card),
      );
      actions.appendChild(cancelBtn);

      card.appendChild(actions);
    }

    ordersList.appendChild(card);
  });

  const totalItems = orders.length + smsActivations.length;
  emptyState.classList.toggle("hidden", totalItems > 0);
}

async function loadOrders() {
  try {
    const [emailData, smsData] = await Promise.allSettled([
      api("/api/orders"),
      api("/api/sms-activations"),
    ]);
    const orders =
      emailData.status === "fulfilled" ? emailData.value.orders || [] : [];
    const activations =
      smsData.status === "fulfilled" ? smsData.value.activations || [] : [];
    renderOrders(orders, activations);
    liveStatus.textContent = `Live · ${orders.length} email · ${activations.length} SMS`;
    liveStatus.className = "status-pill live";
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = "status-pill error";
  }
}

async function cancelOrder(id) {
  try {
    await api(`/api/orders/${id}`, { method: "DELETE" });
    await loadOrders();
    await loadWallet();
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = "status-pill error";
  }
}

// ── Cancel SMS Activation ──────────────────────────────────
async function cancelSmsActivation(activationId, card) {
  if (!activationId) return;

  // 使用 showConfirm，将实际取消操作放在回调中
  showConfirm(
    "Cancel this SMS activation? Funds will be refunded.",
    async () => {
      // 用户确认后，禁用按钮
      const actions = card?.querySelector(".order-actions");
      if (actions) {
        const btns = actions.querySelectorAll("button");
        btns.forEach((b) => (b.disabled = true));
      }

      try {
        const result = await api(`/api/sms/status/${activationId}`, {
          method: "POST",
          body: JSON.stringify({ status: 8 }),
        });
        if (result.ok) {
          showWarning("✅ SMS activation cancelled. Refund will be processed.");
          // 刷新订单列表
          await loadOrders();
          await loadWallet();
        }
      } catch (err) {
        // 解析错误信息
        let msg = err.message;
        if (msg.includes("EARLY_CANCEL_DENIED")) {
          msg =
            "❌ Cannot cancel within the first 2 minutes. Please wait and try again.";
        } else if (msg.includes("FREE_CANCELLATION_EXPIRED")) {
          msg =
            "❌ Free cancellation period (20 min) has expired. Contact support.";
        } else if (msg.includes("OTP_RECEIVED")) {
          msg =
            "❌ Cannot cancel – verification code already received on this number.";
        } else if (msg.includes("ACTIVATION_NOT_ACTIVE")) {
          msg = "❌ Activation is no longer active.";
        }
        showWarning(msg);
        // 重新启用按钮
        if (actions) {
          const btns = actions.querySelectorAll("button");
          btns.forEach((b) => (b.disabled = false));
        }
      }
    },
  );
  // 注意：用户取消时，不会执行回调，按钮保持可用，无需额外操作
}

// ── Config & Services ────────────────────────────────────────────
async function loadHealth() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    refreshMs = health.pollIntervalMs || 2000;
    updatePollDisplay(refreshMs);
  } catch {}
}

function updatePollDisplay(ms) {
  pollIntervalEl.textContent = fmtSeconds(ms);
  if (pollIntervalMs) pollIntervalMs.textContent = fmtSeconds(ms);
}

async function loadConfig() {
  try {
    const configData = await fetch("/api/config").then((r) => r.json());
    refreshMs = configData.pollIntervalMs || 2000;
    updatePollDisplay(refreshMs);
    if (configData.botUsername)
      telegramLink.href = `https://t.me/${configData.botUsername}`;
    await loadServices();
  } catch (err) {
    serviceSelect.innerHTML = '<option value="">Failed to load config</option>';
    if (orderCostHint)
      orderCostHint.textContent = "Config load error: " + err.message;
  }
}

async function loadServices() {
  // Each service loads independently — one failure won't block others
  const results = await Promise.allSettled([
    // Email domains (requires auth)
    (async () => {
      const data = await api("/api/domains");
      renderServices(data.domains);
    })(),
    // SMS countries (public, no auth needed)
    (async () => {
      const cData = await fetch("/api/sms-countries").then((r) => r.json());
      renderSmsCountries(cData.countries);
    })(),
  ]);

  // Handle failures gracefully
  if (results[0].status === "rejected") {
    serviceSelect.innerHTML = '<option value="">Services unavailable</option>';
    if (orderCostHint)
      orderCostHint.textContent =
        "Could not load services. Check Hero-SMS API key.";
    console.error(
      "loadServices email domains error:",
      results[0].reason?.message,
    );
  }
  if (results[1].status === "rejected") {
    if (smsCountrySelect)
      smsCountrySelect.innerHTML =
        '<option value="">Failed to load countries</option>';
    console.error("Failed to load SMS countries:", results[1].reason?.message);
  }

  // SMS services — only if country wasn't auto-selected by renderSmsCountries
  if (!smsSelectedCountry) {
    try {
      await loadSmsServices();
    } catch {}
  }
}

// ── Top-up ───────────────────────────────────────────────────────
async function runTopup(body) {
  lastPaymentId = null;
  const existingQr = document.querySelector(".payment-qr");
  if (existingQr) existingQr.remove();
  if (topupConfirmSection) topupConfirmSection.classList.add("hidden");
  if (confirmPaymentResult) confirmPaymentResult.textContent = "";
  topupResult.textContent = "Creating payment…";

  try {
    const result = await api("/api/topup", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.billUrl) {
      topupResult.innerHTML = `Pay via Billplz: <a href="${result.billUrl}" target="_blank" rel="noopener">Open payment</a>`;
      window.open(result.billUrl, "_blank");
    } else if (result.instructions) {
      topupResult.textContent = [
        ...result.instructions,
        `Payment #${result.paymentId}`,
      ].join(" · ");
      if (result.qrUrl) {
        const qrImg = document.createElement("img");
        qrImg.src = result.qrUrl;
        qrImg.alt = "Payment QR code";
        qrImg.className = "payment-qr";
        topupResult.after(qrImg);
      }
      if (result.paymentId) {
        lastPaymentId = result.paymentId;
        if (topupConfirmSection) topupConfirmSection.classList.remove("hidden");
      }
      loadPaymentHistory().catch(() => {});
    } else {
      topupResult.textContent = result.note || "Payment created.";
    }
  } catch (err) {
    topupResult.textContent = err.message;
    console.error("Topup error:", err.message);
  }
}

// ── Transaction History ─────────────────────────────────────────
let txCurrentPage = 1;
const TX_LIMIT = 20;

async function loadTransactions(page = 1, type = "all") {
  const params = new URLSearchParams({
    page,
    limit: TX_LIMIT,
    type,
  });
  try {
    const data = await api(`/api/wallet/transactions?${params}`);
    renderTransactions(data.transactions, data.pagination);
  } catch (err) {
    console.error("Load transactions error:", err.message);
    const container = document.getElementById("transactions-list");
    if (container)
      container.innerHTML = `<p class="error">Failed to load: ${err.message}</p>`;
  }
}

function renderTransactions(transactions, pagination) {
  const container = document.getElementById("transactions-list");
  const empty = document.getElementById("tx-empty");
  const paginationEl = document.getElementById("tx-pagination");
  if (!container) return;

  if (!transactions || transactions.length === 0) {
    container.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    if (paginationEl) paginationEl.style.display = "none";
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (paginationEl) paginationEl.style.display = "flex";

  container.innerHTML = transactions
    .map((tx) => {
      const typeLabel =
        tx.type === "credit"
          ? "💰 Credit"
          : tx.type === "debit"
            ? "💸 Debit"
            : tx.type === "refund"
              ? "↩️ Refund"
              : tx.type;
      const sign = tx.type === "credit" || tx.type === "refund" ? "+" : "-";
      const amount = tx.amount
        ? `${sign}${Math.abs(tx.amount).toLocaleString()} gems`
        : "";
      const balance = tx.balance_after || tx.balanceAfter;
      return `
      <div class="transaction-item" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border, #333);">
        <div>
          <div style="font-weight:600;">${typeLabel}</div>
          <div style="font-size:0.85rem;color:var(--muted);">${tx.note || tx.description || ""}</div>
          <div style="font-size:0.75rem;color:var(--muted);">${new Date(tx.created_at || tx.createdAt).toLocaleString()}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;color:${tx.type === "credit" ? "#4ade80" : tx.type === "debit" ? "#f87171" : "#fbbf24"};">${amount}</div>
          <div style="font-size:0.75rem;color:var(--muted);">Balance: ${balance?.toLocaleString() || "?"}</div>
        </div>
      </div>
    `;
    })
    .join("");

  // 分页控件
  const pageInfo = document.getElementById("tx-page-info");
  const prevBtn = document.getElementById("tx-prev");
  const nextBtn = document.getElementById("tx-next");
  if (pageInfo)
    pageInfo.textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
  if (prevBtn) prevBtn.disabled = pagination.page <= 1;
  if (nextBtn) nextBtn.disabled = pagination.page >= pagination.totalPages;

  // 事件绑定（使用 onclick 避免重复绑定）
  if (prevBtn)
    prevBtn.onclick = () => {
      if (pagination.page > 1)
        loadTransactions(pagination.page - 1, getCurrentFilter());
    };
  if (nextBtn)
    nextBtn.onclick = () => {
      if (pagination.page < pagination.totalPages)
        loadTransactions(pagination.page + 1, getCurrentFilter());
    };
}

function getCurrentFilter() {
  const sel = document.getElementById("tx-type-filter");
  return sel ? sel.value : "all";
}

// ── Payment History ────────────────────────────────────────────
async function loadPaymentHistory() {
  const paymentHistory = $("payment-history");
  const paymentHistoryList = $("payment-history-list");
  if (!paymentHistory || !paymentHistoryList) return;
  try {
    const data = await api("/api/payments");
    const payments = data.payments || [];
    paymentHistoryList.innerHTML = "";
    if (payments.length === 0) {
      paymentHistory.classList.add("hidden");
      return;
    }
    paymentHistory.classList.remove("hidden");
    payments.forEach((p) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border, #333);font-size:0.85rem;";
      const providerLabel =
        p.provider === "manual_tng"
          ? "📱 TnG"
          : p.provider === "manual_bank"
            ? "🏦 Bank"
            : "💳 Billplz";
      const statusColor =
        p.status === "paid"
          ? "#4ade80"
          : p.status === "cancelled"
            ? "#f87171"
            : "#fbbf24";
      row.innerHTML = `<span>${providerLabel} · RM ${p.amountMyr} → ${p.gems?.toLocaleString?.() || p.gems} gems</span>
        <span style="display:flex;align-items:center;gap:8px;">
          <span style="color:${statusColor};font-weight:600;">${p.status.toUpperCase()}</span>
          ${p.status === "pending" || p.status === "pending_review" ? `<button class="btn-secondary" style="font-size:0.75rem;padding:2px 8px;" data-pid="${p.id}">Withdraw</button>` : ""}
        </span>`;
      paymentHistoryList.appendChild(row);
      // Attach withdraw handler
      const withdrawBtn = row.querySelector(`button[data-pid="${p.id}"]`);
      if (withdrawBtn) {
        withdrawBtn.addEventListener("click", async () => {
          try {
            await api("/api/cancel-payment", {
              method: "POST",
              body: JSON.stringify({ paymentId: p.id }),
            });
            withdrawBtn.textContent = "Cancelled";
            withdrawBtn.disabled = true;
            setTimeout(() => loadPaymentHistory(), 2000);
          } catch (err) {
            console.error("Withdraw error:", err.message);
            withdrawBtn.textContent = "Failed";
            setTimeout(() => (withdrawBtn.textContent = "Withdraw"), 3000);
          }
        });
      }
    });
  } catch (err) {
    console.error("Payment history load error:", err.message);
  }
}

// Payment proof upload — DOMContentLoaded safe
function setupPaymentProof() {
  if (!confirmPaymentBtn) return;

  confirmPaymentBtn.addEventListener("click", async () => {
    if (!lastPaymentId) {
      if (confirmPaymentResult)
        confirmPaymentResult.textContent = "No payment to confirm.";
      return;
    }
    const file = paymentProofInput?.files?.[0];
    if (!file) {
      if (confirmPaymentResult)
        confirmPaymentResult.textContent = "Please select a receipt image.";
      return;
    }

    confirmPaymentBtn.disabled = true;
    confirmPaymentBtn.textContent = "Sending...";
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result.split(",")[1]);
        reader.onerror = (e) => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

      await api("/api/admin/submit-proof", {
        method: "POST",
        body: JSON.stringify({
          paymentId: lastPaymentId,
          proof: base64,
          fileName: file.name,
        }),
      });

      if (confirmPaymentResult) {
        confirmPaymentResult.textContent =
          "✅ Proof submitted! Wait for admin approval.";
        confirmPaymentResult.style.color = "#4ade80";
      }
      if (topupConfirmSection) topupConfirmSection.classList.add("hidden");
    } catch (err) {
      if (confirmPaymentResult) {
        confirmPaymentResult.textContent = "Failed: " + err.message;
        confirmPaymentResult.style.color = "#f87171";
      }
      console.error("Proof upload error:", err.message);
    } finally {
      confirmPaymentBtn.disabled = false;
      confirmPaymentBtn.textContent = "Send Payment Proof";
    }
  });
}

function updateCustomTopupHint() {
  const amountMyr = parseFloat(customMyrInput.value);
  if (!amountMyr || !wallet?.billplzFee) {
    customMyrInput.setAttribute("placeholder", "Enter RM amount (min RM 5)");
    return;
  }
  const fee = amountMyr * wallet.billplzFee;
  const total = amountMyr + fee;
  customMyrInput.setAttribute(
    "placeholder",
    `Enter RM amount (min RM 5) — total with fee: RM ${total.toFixed(2)}`,
  );
}

// ── Session ──────────────────────────────────────────────────────
async function initSession() {
  // First priority: URL token (from Telegram bot /web command or direct link)
  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get("token");
  if (urlToken) {
    console.log("[SESSION] Using token from URL query parameter");
    setToken(urlToken);
    tokenPanel.hidden = true;
    if (tokenInput) tokenInput.value = urlToken;
    // Clean URL
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
    return;
  }

  // Second priority: Telegram WebApp initData auth
  const inTelegram = initTelegramWebApp();
  if (inTelegram) {
    // 等待 initData 就绪，最多重试 6 次（约 2.4 秒）
    const hasInitData = await waitForInitData(6, 400);
    if (hasInitData) {
      // 尝试认证，最多重试 3 次（每次间隔 500ms）
      let authSuccess = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          console.log(`[SESSION] Auth retry ${attempt + 1}`);
          await new Promise((r) => setTimeout(r, 500));
        }
        if (await authFromTelegram()) {
          authSuccess = true;
          break;
        }
      }
      if (authSuccess) {
        tokenInput.value = token;
        return;
      } else {
        console.warn("[SESSION] Telegram auth failed after retries");
      }
    } else {
      console.warn("[SESSION] Telegram initData not available after waiting");
    }
    // 如果认证失败，继续执行后续逻辑（saved token 或新 session）
    // 但此时用户仍可通过手动 Connect 重新认证
  }

  // Third priority: saved token from localStorage — validate it first
  const savedToken = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  if (savedToken) {
    setToken(savedToken);
    // Verify token is still valid
    try {
      console.log("[SESSION] Testing saved token...");
      await api("/api/wallet");
      console.log("[SESSION] Saved token is valid, using it");
      tokenPanel.hidden = true;
      return;
    } catch (e) {
      console.log("[SESSION] Saved token invalid:", e.message);
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      token = "";
      // Fall through to create new web session
    }
  }

  // Last resort: create new web session
  try {
    console.log("[SESSION] Creating new web session");
    const session = await fetch("/api/session").then((r) => r.json());
    setToken(session.token);
    tokenInput.value = token;
  } catch (e) {
    console.error("[SESSION] Failed to create web session:", e.message);
  }
}

function startAutoRefresh() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!token) return;
    loadOrders().catch(() => {
      liveStatus.textContent = "Reconnecting…";
      liveStatus.className = "status-pill error";
    });
    loadWallet().catch(() => {});
    autoPollSmsCodes().catch(() => {});
    loadPaymentHistory().catch(() => {});
  }, refreshMs);
}

// ── Event bindings ───────────────────────────────────────────────
orderForm?.addEventListener("submit", createOrder);
smsOrderForm?.addEventListener("submit", createSmsOrder);
refreshBtn?.addEventListener("click", () => {
  loadOrders();
  loadWallet();
});
serviceSelect?.addEventListener("change", updateOrderCostHint);

customTopupBtn?.addEventListener("click", () => {
  const amountMyr = parseFloat(customMyrInput.value);
  const method = topupMethodSelect.value;
  if (!amountMyr || !method) return;
  if (amountMyr < 5) {
    topupResult.textContent = "Minimum top-up is RM 5";
    return;
  }
  runTopup({ method, amountMyr });
});

customMyrInput?.addEventListener("input", updateCustomTopupHint);

tokenSave?.addEventListener("click", async () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  setToken(value);
  try {
    await loadWallet();
    await loadOrders();
    startAutoRefresh();
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    liveStatus.textContent = "Invalid token";
    liveStatus.className = "status-pill error";
  }
});

// ── Transaction History events ──────────────────────────────
document.getElementById("tx-type-filter")?.addEventListener("change", () => {
  loadTransactions(1, getCurrentFilter());
});

document.getElementById("tx-refresh-btn")?.addEventListener("click", () => {
  loadTransactions(txCurrentPage, getCurrentFilter());
});

// ── Styles ───────────────────────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  .payment-qr { max-width: 250px; width: 100%; height: auto; border-radius: 12px; display: block; margin: 12px 0; }
  .stat-helper { font-size: 0.75rem; color: var(--muted); margin-top: 2px; }
  .error-hint { color: #ff6b6b; font-size: 0.8rem; }
  .sms-summary { background: var(--surface-strong); border-radius: 10px; padding: 10px 14px; margin: 10px 0; font-size: 0.9rem; color: var(--accent); }
  .topup-confirm { margin-top: 12px; padding: 14px; background: var(--surface-strong); border-radius: 12px; display: flex; flex-direction: column; gap: 8px; }
  .topup-confirm input[type="file"] { color: var(--text); font: inherit; font-size: 0.85rem; padding: 8px 0; }
  .confirm-btn { background: linear-gradient(135deg, #fbbf24, #f59e0b); color: #000; font-weight: 700; }
`;
document.head.appendChild(style);

// ── Confirmation modal ───────────────────────────────────────────
let pendingAction = null;

function showConfirm(message, onConfirm) {
  pendingAction = onConfirm;
  $("confirm-message").textContent = message;
  $("confirm-modal").style.display = "flex";
}

$("confirm-yes")?.addEventListener("click", () => {
  $("confirm-modal").style.display = "none";
  if (pendingAction) {
    const fn = pendingAction;
    pendingAction = null;
    fn();
  }
});
$("confirm-no")?.addEventListener("click", () => {
  $("confirm-modal").style.display = "none";
  pendingAction = null;
});
$("confirm-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    $("confirm-modal").style.display = "none";
    pendingAction = null;
  }
});

// ── Admin panel ──────────────────────────────────────────────────
const adminPanel = $("admin-panel");
const adminApprovalsList = $("admin-approvals-list");
const adminEmptyState = $("admin-empty-state");
const refreshAdminBtn = $("refresh-admin-btn");

async function loadAdminPendingPayments() {
  if (!token) return;
  try {
    const data = await api("/api/admin/pending-payments");
    renderAdminPayments(data.payments);
    if (adminPanel) adminPanel.style.display = "block";
  } catch {
    if (adminPanel) adminPanel.style.display = "none";
  }
}

function renderAdminPayments(payments) {
  if (!adminApprovalsList || !adminEmptyState) return;
  adminApprovalsList.innerHTML = "";
  adminEmptyState.classList.toggle("hidden", payments.length > 0);

  payments.forEach((p) => {
    const card = document.createElement("article");
    card.className = "order-card";
    card.innerHTML = `
      <div class="order-top">
        <div class="order-email">#${p.id} — ${p.provider === "manual_tng" ? "📱 TnG" : "🏦 Bank Transfer"}</div>
        <span class="order-status">PENDING</span>
      </div>
      <div class="order-meta">RM ${p.amountMyr} → ${p.gems.toLocaleString()} gems · User: ${p.telegramId || p.userId}</div>
      ${p.meta?.proof ? '<div class="order-meta">📎 Proof attached</div>' : ""}
      <div class="order-actions">
        <button type="button" class="approve-btn" data-id="${p.id}">✅ Approve</button>
        <button type="button" class="reject-btn" data-id="${p.id}">❌ Reject</button>
      </div>
    `;

    card.querySelector(".approve-btn")?.addEventListener("click", () => {
      showConfirm(`Approve payment #${p.id} for RM ${p.amountMyr}?`, () =>
        adminAction("approve", p.id),
      );
    });
    card.querySelector(".reject-btn")?.addEventListener("click", () => {
      showConfirm(`Reject payment #${p.id} (RM ${p.amountMyr})?`, () =>
        adminAction("reject", p.id),
      );
    });
    adminApprovalsList.appendChild(card);
  });
}

async function adminAction(action, paymentId) {
  try {
    await api(`/api/admin/${action}-payment`, {
      method: "POST",
      body: JSON.stringify({ paymentId }),
    });
    await loadAdminPendingPayments();
    liveStatus.textContent = `Payment #${paymentId} ${action}d`;
    liveStatus.className = "status-pill live";
  } catch (err) {
    liveStatus.textContent = `Admin ${action} failed: ${err.message}`;
    liveStatus.className = "status-pill error";
  }
}

refreshAdminBtn?.addEventListener("click", loadAdminPendingPayments);

// ── Bootstrap ────────────────────────────────────────────────────
console.log("[DEBUG] App starting, initializing session...");

// Override loadWallet to also try loading admin panel if user is admin
let isUserAdmin = false;
const origLoadWallet = loadWallet;
loadWallet = async function () {
  const w = await api("/api/wallet");
  renderWallet(w);
  if (isUserAdmin) loadAdminPendingPayments().catch(() => {});
};

// Check admin status on startup
async function checkAdmin() {
  try {
    const result = await api("/api/admin/check");
    isUserAdmin = result.isAdmin;
    if (isUserAdmin && adminPanel) {
      adminPanel.classList.remove("hidden");
      loadAdminPendingPayments().catch(() => {});
    }
  } catch {
    isUserAdmin = false;
  }
}

// Setup proof upload button (safe to call before DOMContentLoaded)
setupPaymentProof();

async function bootstrap() {
  liveStatus.textContent = "Initializing...";
  console.log("[DEBUG] Bootstrap: initSession...");
  await initSession();

  if (!token) {
    liveStatus.textContent = "No access token — open via Telegram /start";
    liveStatus.className = "status-pill error";
    if (telegramLink) {
      telegramLink.textContent = "🤖 Open Telegram Bot";
      telegramLink.style.display = "inline-flex";
    }
    return;
  }

  liveStatus.textContent = "Loading services...";
  console.log("[DEBUG] Bootstrap: token set, loading config...");
  await loadConfig();
  console.log("[DEBUG] Bootstrap: loadHealth...");
  await loadHealth();

  // Clean URL
  const url = new URL(window.location.href);
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url);
  }

  liveStatus.textContent = "Checking access...";
  await checkAdmin();
  await loadWallet();
  await loadOrders();

  liveStatus.textContent = `Live · ${ordersList?.children?.length || 0} orders`;
  liveStatus.className = "status-pill live";
  // 加载交易历史（首次默认全部类型）
  loadTransactions(1, "all").catch(() => {});
  startAutoRefresh();
  console.log("[DEBUG] Bootstrap: complete");
}

bootstrap().catch((err) => {
  console.error("[DEBUG] Bootstrap failed:", err.message);
  liveStatus.textContent = err.message;
  liveStatus.className = "status-pill error";
});

if (
  window.location.hash === "#topup" ||
  new URLSearchParams(window.location.search).get("topup")
) {
  $("topup-panel")?.scrollIntoView({ behavior: "smooth" });
}
