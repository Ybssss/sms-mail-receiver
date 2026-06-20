const STORAGE_KEY = "hero_mail_token";
let token = "";
let pollTimer = null;
let refreshMs = 2000;
let wallet = null;
let domainList = [];
let smsServiceList = [];
let tgWebApp = null;

const orderForm = document.getElementById("order-form");
const serviceSelect = document.getElementById("service-select");
const smsServiceSelect = document.getElementById("sms-service-select");
const smsCountrySelect = document.getElementById("sms-country-select");
const smsSearchInput = document.getElementById("sms-service-search");
const smsOrderForm = document.getElementById("sms-order-form");
const smsResult = document.getElementById("sms-result");
const smsError = document.getElementById("sms-error");
const ordersList = document.getElementById("orders-list");
const emptyState = document.getElementById("empty-state");
const liveStatus = document.getElementById("live-status");
const pollIntervalEl = document.getElementById("poll-interval");
const pollIntervalMs = document.getElementById("poll-interval-ms");
const gemsBalanceEl = document.getElementById("gems-balance");
const gemsPerMyrEl = document.getElementById("gems-per-myr");
const topupMethodSelect = document.getElementById("topup-method");
const customMyrInput = document.getElementById("custom-myr");
const customTopupBtn = document.getElementById("custom-topup-btn");
const topupResult = document.getElementById("topup-result");
const orderCostHint = document.getElementById("order-cost-hint");
const serviceError = document.getElementById("service-error");
const refreshBtn = document.getElementById("refresh-btn");
const tokenPanel = document.getElementById("token-panel");
const tokenInput = document.getElementById("token-input");
const tokenSave = document.getElementById("token-save");
const telegramLink = document.getElementById("telegram-link");

function initTelegramWebApp() {
  tgWebApp = window.Telegram?.WebApp;
  if (!tgWebApp?.initData) return false;

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
  return true;
}

async function authFromTelegram() {
  if (!tgWebApp?.initData) return false;

  const response = await fetch("/api/telegram-auth", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: tgWebApp.initData,
  });

  if (!response.ok) return false;

  const data = await response.json();
  setToken(data.token);
  tokenPanel.hidden = true;

  if (data.firstName) {
    const subtitle = document.querySelector(".subtitle");
    if (subtitle)
      subtitle.textContent = `Hi ${data.firstName} — top up gems, order SMS numbers, receive codes instantly.`;
  }

  return true;
}

function fmt(n) {
  return Number(n).toLocaleString("en-MY");
}

function fmtSeconds(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

function setToken(nextToken) {
  token = nextToken;
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // sessionStorage may be restricted in some embedded contexts
  }
  tokenPanel.hidden = Boolean(token);
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

  // If no methods, show unavailable message
  if (topupMethodSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Top Up Temporarily Unavailable";
    opt.disabled = true;
    topupMethodSelect.appendChild(opt);
  }

  // Show processing fee hint if Billplz is an option
  const feeHint = document.getElementById("processing-fee-hint");
  if (feeHint) {
    const hasBillplz = w.methods.some((m) => m.id === "billplz");
    if (hasBillplz) feeHint.classList.remove("hidden");
    else feeHint.classList.add("hidden");
  }
}

async function loadWallet() {
  const w = await api("/api/wallet");
  renderWallet(w);
}

function renderServices(domains) {
  domainList = domains;
  serviceSelect.innerHTML = '<option value="">Select a service...</option>';
  serviceError.classList.add("hidden");

  if (!domains || domains.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No services available";
    opt.disabled = true;
    serviceSelect.appendChild(opt);
    orderCostHint.textContent = "No services returned from provider.";
    return;
  }

  // Show all services with gem cost and stock info
  domains.forEach((d) => {
    const name = d.name || d.domain;
    const count = d.count != null ? d.count : "?";
    const opt = document.createElement("option");
    opt.value = name;
    // Store extra data attributes on the option for the backend
    opt.dataset.site = d.site || d.name || d.domain || "";
    opt.dataset.domain = d.domain || d.name || "";
    opt.textContent = `${name} — ${fmt(d.costGems)} gems (stock: ${count})`;
    serviceSelect.appendChild(opt);
  });

  updateOrderCostHint();
}

function renderOrders(orders) {
  ordersList.innerHTML = "";

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
    meta.textContent = `#${order.id} · ${order.site || ""} · ${order.domain || ""}${gemsPart}`;

    card.append(top, meta);

    if (order.value) {
      const value = document.createElement("div");
      value.className = "order-value";
      value.textContent = order.value;
      card.appendChild(value);
    }

    if (order.message) {
      const message = document.createElement("div");
      message.className = "order-meta";
      message.textContent = order.message;
      card.appendChild(message);
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

  emptyState.classList.toggle("hidden", orders.length > 0);
}

async function loadOrders() {
  try {
    const data = await api("/api/orders");
    renderOrders(data.orders);
    liveStatus.textContent = `Live · ${data.orders.length} SMS`;
    liveStatus.className = "status-pill live";
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = "status-pill error";
  }
}

async function loadHealth() {
  try {
    const health = await fetch("/api/health").then((res) => res.json());
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
    const configData = await fetch("/api/config").then((res) => res.json());
    refreshMs = configData.pollIntervalMs || 2000;
    updatePollDisplay(refreshMs);

    if (configData.botUsername)
      telegramLink.href = `https://t.me/${configData.botUsername}`;

    await loadServices();
  } catch (err) {
    serviceSelect.innerHTML = '<option value="">Failed to load config</option>';
    orderCostHint.textContent = "Config load error: " + err.message;
  }
}

async function loadServices() {
  // Load email domains
  try {
    const data = await api("/api/domains");
    renderServices(data.domains);
  } catch (err) {
    serviceSelect.innerHTML =
      '<option value="">Error loading services</option>';
    serviceError.textContent = "Failed to load services: " + err.message;
    serviceError.classList.remove("hidden");
    orderCostHint.textContent =
      "Could not load services. Check Hero-SMS API key.";
  }

  // Load SMS countries
  try {
    const cData = await fetch("/api/sms-countries").then((r) => r.json());
    renderSmsCountries(cData.countries);
  } catch {}
  // Load SMS activation services
  try {
    const smsData = await api("/api/sms-services");
    renderSmsServices(smsData.services);
  } catch (err) {
    if (smsError) {
      smsError.textContent = "SMS services unavailable: " + err.message;
      smsError.classList.remove("hidden");
    }
  }
}

function renderSmsCountries(countries) {
  if (!smsCountrySelect) return;
  smsCountrySelect.innerHTML = '<option value="">All countries</option>';
  if (!Array.isArray(countries) || !countries.length) return;
  countries.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.eng || c.rus || `Country ${c.id}`;
    smsCountrySelect.appendChild(opt);
  });
  // Set current country if known from API response
  if (smsCountrySelect.dataset.current) {
    smsCountrySelect.value = smsCountrySelect.dataset.current;
  }
}

if (smsCountrySelect) {
  smsCountrySelect.addEventListener("change", async () => {
    const countryId = smsCountrySelect.value;
    try {
      const url = countryId
        ? `/api/sms-services?country=${countryId}`
        : "/api/sms-services";
      const data = await api(url);
      if (data.currentCountryId)
        smsCountrySelect.dataset.current = String(data.currentCountryId);
      renderSmsServices(data.services);
    } catch (err) {
      if (smsError) {
        smsError.textContent = err.message;
        smsError.classList.remove("hidden");
      }
    }
  });
}

function renderSmsServices(services) {
  if (!smsServiceSelect) return;
  smsServiceList = services || [];
  if (smsError) smsError.classList.add("hidden");
  if (smsResult) smsResult.textContent = "";
  populateSmsDropdown();

  if (smsSearchInput) {
    smsSearchInput.classList.remove("hidden-input");
    smsSearchInput.placeholder = `Search ${services?.length || 0} services...`;
    smsSearchInput.disabled = false;
  }
}

function populateSmsDropdown(filter) {
  if (!smsServiceSelect) return;
  const query = (filter || smsSearchInput?.value || "").toLowerCase().trim();

  smsServiceSelect.innerHTML = '<option value="">Select a service...</option>';

  const filtered = query
    ? smsServiceList.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.code.toLowerCase().includes(query),
      )
    : smsServiceList;

  if (!filtered.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = query
      ? `No match for "${query}"`
      : "No SMS services available";
    opt.disabled = true;
    smsServiceSelect.appendChild(opt);
    return;
  }

  filtered.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.code;
    opt.textContent = `${s.name} — $${s.costUsd?.toFixed(2) || "?"} (stock: ${s.stock || "?"})`;
    smsServiceSelect.appendChild(opt);
  });
}

// Live search filtering
if (smsSearchInput) {
  smsSearchInput.addEventListener("input", () => {
    populateSmsDropdown(smsSearchInput.value);
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
    const result = await api("/api/sms/order", {
      method: "POST",
      body: JSON.stringify({ service: selected }),
    });

    const service = smsServiceList.find((s) => s.code === selected);
    const lines = [
      `✅ SMS Number Ordered!`,
      `Service: ${result.serviceName || service?.name || selected}`,
      `Phone: ${result.phoneNumber}`,
      `Cost: ${result.costGems.toLocaleString()} gems`,
      `Expires: ${result.activationEndTime ? new Date(result.activationEndTime).toLocaleString() : "N/A"}`,
      "",
      `Activation ID: ${result.activationId}`,
    ];

    if (smsResult) {
      smsResult.textContent = lines.join("\n");
      // Create a check SMS button
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
    if (smsError) {
      smsError.textContent = err.message;
      smsError.classList.remove("hidden");
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

function updateOrderCostHint() {
  const selected = serviceSelect.value;
  if (!selected) {
    orderCostHint.textContent = "Select a service to see gem cost.";
    return;
  }
  const domain = domainList.find((d) => (d.name || d.domain) === selected);
  if (domain) {
    orderCostHint.textContent = `Cost: ${fmt(domain.costGems)} gems`;
  } else {
    orderCostHint.textContent = "Select a service to see gem cost.";
  }
}

async function runTopup(body) {
  // Remove any previous QR image
  const existingQr = document.querySelector(".payment-qr");
  if (existingQr) existingQr.remove();
  topupResult.textContent = "Creating payment…";
  try {
    const result = await api("/api/topup", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.billUrl) {
      topupResult.innerHTML = `Pay via Billplz (FPX/card/TnG): <a href="${result.billUrl}" target="_blank" rel="noopener">Open payment</a>`;
      window.open(result.billUrl, "_blank");
    } else if (result.instructions) {
      topupResult.textContent = [
        ...result.instructions,
        `Payment #${result.paymentId}`,
      ].join(" · ");
      // Show QR image for manual payments if available
      if (result.qrUrl) {
        const qrImg = document.createElement("img");
        qrImg.src = result.qrUrl;
        qrImg.alt = "Payment QR code";
        qrImg.className = "payment-qr";
        topupResult.after(qrImg);
      }
    } else {
      topupResult.textContent = result.note || "Payment created.";
    }
  } catch (err) {
    topupResult.textContent = err.message;
  }
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
    const site = (domain.site || domain.name || domain.domain || "").trim();
    const dom = (domain.domain || domain.name || "").trim();

    if (!site) throw new Error("Invalid service: missing site identifier");
    if (!dom) throw new Error("Invalid service: missing domain name");

    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ site, domain: dom }),
    });
    await loadOrders();
    await loadWallet();
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = "status-pill error";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Order now";
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

async function initSession() {
  const inTelegram = initTelegramWebApp();

  if (inTelegram && (await authFromTelegram())) {
    tokenInput.value = token;
    return;
  }

  const savedToken = (() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  const query = savedToken ? `?token=${encodeURIComponent(savedToken)}` : "";

  const session = await fetch(`/api/session${query}`).then((res) => res.json());
  setToken(session.token);
  tokenInput.value = token;

  if (savedToken) tokenPanel.hidden = true;
}

function startAutoRefresh() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadOrders().catch(() => {
      liveStatus.textContent = "Reconnecting…";
      liveStatus.className = "status-pill error";
    });
    loadWallet().catch(() => {});
  }, refreshMs);
}

orderForm.addEventListener("submit", createOrder);
if (smsOrderForm) smsOrderForm.addEventListener("submit", createSmsOrder);
refreshBtn.addEventListener("click", () => {
  loadOrders();
  loadWallet();
});
serviceSelect.addEventListener("change", updateOrderCostHint);

// ── Payment QR image style ──────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  .payment-qr {
    max-width: 250px;
    width: 100%;
    height: auto;
    border-radius: 12px;
    display: block;
    margin: 12px 0;
  }
  .stat-helper {
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 2px;
  }
  .error-hint {
    color: #ff6b6b;
    font-size: 0.8rem;
  }
`;
document.head.appendChild(style);

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

customTopupBtn.addEventListener("click", () => {
  const amountMyr = parseFloat(customMyrInput.value);
  const method = topupMethodSelect.value;
  if (!amountMyr || !method) return;
  if (
    topupMethodSelect.options[0]?.disabled &&
    topupMethodSelect.options[0]?.textContent.includes("Unavailable")
  ) {
    topupResult.textContent = "Top Up Temporarily Unavailable";
    return;
  }
  if (amountMyr < 5) {
    topupResult.textContent = "Minimum top-up is RM 5";
    return;
  }
  runTopup({ method, amountMyr });
});

customMyrInput.addEventListener("input", updateCustomTopupHint);

tokenSave.addEventListener("click", async () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  setToken(value);
  try {
    await loadWallet();
    await loadOrders();
    startAutoRefresh();
  } catch {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
    liveStatus.textContent = "Invalid token";
    liveStatus.className = "status-pill error";
  }
});

initSession()
  .then(loadConfig)
  .then(loadHealth)
  .then(() => {
    // Clean token from URL if present (security: don't expose in browser history)
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url);
    }
  })
  .then(loadWallet)
  .then(loadOrders)
  .then(startAutoRefresh)
  .catch((err) => {
    liveStatus.textContent = err.message;
    liveStatus.className = "status-pill error";
  });

// ── Confirmation modal (misclick prevention) ────────────────────
let pendingAction = null;

function showConfirm(message, onConfirm) {
  pendingAction = onConfirm;
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-modal").style.display = "flex";
}

document.getElementById("confirm-yes").addEventListener("click", () => {
  document.getElementById("confirm-modal").style.display = "none";
  if (pendingAction) {
    const fn = pendingAction;
    pendingAction = null;
    fn();
  }
});

document.getElementById("confirm-no").addEventListener("click", () => {
  document.getElementById("confirm-modal").style.display = "none";
  pendingAction = null;
});

// Close modal on overlay click
document.getElementById("confirm-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById("confirm-modal").style.display = "none";
    pendingAction = null;
  }
});

// ── Admin panel ─────────────────────────────────────────────────
const adminPanel = document.getElementById("admin-panel");
const adminApprovalsList = document.getElementById("admin-approvals-list");
const adminEmptyState = document.getElementById("admin-empty-state");
const refreshAdminBtn = document.getElementById("refresh-admin-btn");

async function loadAdminPendingPayments() {
  try {
    const data = await api("/api/admin/pending-payments");
    renderAdminPayments(data.payments);
    adminPanel.style.display = "block";
  } catch {
    adminPanel.style.display = "none";
  }
}

function renderAdminPayments(payments) {
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
      <div class="order-actions">
        <button type="button" class="approve-btn" data-id="${p.id}">✅ Approve</button>
        <button type="button" class="reject-btn" data-id="${p.id}">❌ Reject</button>
      </div>
    `;

    card.querySelector(".approve-btn").addEventListener("click", () => {
      showConfirm(
        `Approve payment #${p.id} for RM ${p.amountMyr} → ${p.gems.toLocaleString()} gems?\nThis will credit the user's account.`,
        () => adminAction("approve", p.id),
      );
    });

    card.querySelector(".reject-btn").addEventListener("click", () => {
      showConfirm(
        `Reject payment #${p.id} (RM ${p.amountMyr})?\nThis will cancel the payment and the user will not receive gems.`,
        () => adminAction("reject", p.id),
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

refreshAdminBtn.addEventListener("click", loadAdminPendingPayments);

// Try to load admin panel after wallet loads
const origLoadWallet = loadWallet;
loadWallet = async function () {
  const w = await api("/api/wallet");
  renderWallet(w);
  // Try loading admin panel silently
  loadAdminPendingPayments().catch(() => {});
};

if (
  window.location.hash === "#topup" ||
  new URLSearchParams(window.location.search).get("topup")
) {
  document
    .getElementById("topup-panel")
    ?.scrollIntoView({ behavior: "smooth" });
}
