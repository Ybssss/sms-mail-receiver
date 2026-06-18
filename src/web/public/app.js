const STORAGE_KEY = 'hero_mail_token';

const orderForm = document.getElementById('order-form');
const siteInput = document.getElementById('site-input');
const domainInput = document.getElementById('domain-input');
const ordersList = document.getElementById('orders-list');
const emptyState = document.getElementById('empty-state');
const liveStatus = document.getElementById('live-status');
const pollIntervalEl = document.getElementById('poll-interval');
const gemsBalanceEl = document.getElementById('gems-balance');
const gemsPerMyrEl = document.getElementById('gems-per-myr');
const usdMyrEl = document.getElementById('usd-myr');
const packagesGrid = document.getElementById('packages-grid');
const topupMethodSelect = document.getElementById('topup-method');
const customMyrInput = document.getElementById('custom-myr');
const customTopupBtn = document.getElementById('custom-topup-btn');
const topupResult = document.getElementById('topup-result');
const orderCostHint = document.getElementById('order-cost-hint');
const refreshBtn = document.getElementById('refresh-btn');
const tokenPanel = document.getElementById('token-panel');
const tokenInput = document.getElementById('token-input');
const tokenSave = document.getElementById('token-save');
const telegramLink = document.getElementById('telegram-link');

let token = '';
let pollTimer = null;
let refreshMs = 2000;
let wallet = null;
let domainCosts = {};

function fmt(n) {
  return Number(n).toLocaleString('en-MY');
}

function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('token');
}

function setToken(nextToken, updateUrl = true) {
  token = nextToken;
  localStorage.setItem(STORAGE_KEY, token);

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('token', token);
    window.history.replaceState({}, '', url);
  }

  tokenPanel.hidden = Boolean(getTokenFromUrl() || localStorage.getItem(STORAGE_KEY));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderWallet(w) {
  wallet = w;
  gemsBalanceEl.textContent = `💎 ${fmt(w.balance)} gems`;
  gemsPerMyrEl.textContent = fmt(w.exchange.gemsPerMyr);
  usdMyrEl.textContent = w.exchange.usdMyr.toFixed(4);

  packagesGrid.innerHTML = '';
  w.packages.forEach((pkg) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'package-card';
    card.innerHTML = `<strong>${pkg.name}</strong><span>RM ${pkg.priceMyr}</span>`;
    card.addEventListener('click', () => topupPackage(pkg.id));
    packagesGrid.appendChild(card);
  });

  topupMethodSelect.innerHTML = '';
  w.methods.forEach((m) => {
    if (m.id === 'telegram_stars') return;
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    topupMethodSelect.appendChild(opt);
  });
}

async function loadWallet() {
  const w = await api('/api/wallet');
  renderWallet(w);
}

function renderOrders(orders) {
  ordersList.innerHTML = '';

  orders.forEach((order) => {
    const card = document.createElement('article');
    card.className = `order-card${order.value ? ' received' : ''}`;

    const top = document.createElement('div');
    top.className = 'order-top';

    const email = document.createElement('div');
    email.className = 'order-email';
    email.textContent = order.email || `${order.domain} (pending)`;

    const status = document.createElement('span');
    status.className = `order-status${order.value ? ' received' : ''}`;
    status.textContent = order.value ? 'RECEIVED' : order.status;

    top.append(email, status);

    const meta = document.createElement('div');
    meta.className = 'order-meta';
    const gemsPart = order.gemsCharged ? ` · ${fmt(order.gemsCharged)} gems` : '';
    meta.textContent = `#${order.id} · ${order.site} · Hero ID ${order.heroId}${gemsPart}`;

    card.append(top, meta);

    if (order.value) {
      const value = document.createElement('div');
      value.className = 'order-value';
      value.textContent = order.value;
      card.appendChild(value);
    }

    if (order.message) {
      const message = document.createElement('div');
      message.className = 'order-meta';
      message.textContent = order.message;
      card.appendChild(message);
    }

    if (!order.value && order.status !== 'CANCELLED') {
      const actions = document.createElement('div');
      actions.className = 'order-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => cancelOrder(order.id));

      actions.appendChild(cancelBtn);
      card.appendChild(actions);
    }

    ordersList.appendChild(card);
  });

  emptyState.classList.toggle('hidden', orders.length > 0);
}

async function loadOrders() {
  const data = await api('/api/orders');
  renderOrders(data.orders);
  liveStatus.textContent = `Live · ${data.orders.length} orders`;
  liveStatus.className = 'status-pill live';
}

async function loadHealth() {
  const health = await fetch('/api/health').then((res) => res.json());
  pollIntervalEl.textContent = `${health.pollIntervalMs || refreshMs}ms`;
}

async function loadConfig() {
  const config = await fetch('/api/config').then((res) => res.json());
  refreshMs = config.pollIntervalMs || 2000;
  pollIntervalEl.textContent = `${refreshMs}ms`;

  if (config.defaultSite) siteInput.value = config.defaultSite;
  if (config.defaultDomain) domainInput.value = config.defaultDomain;
  if (config.botUsername) telegramLink.href = `https://t.me/${config.botUsername}`;

  await loadDomainCosts();
}

async function loadDomainCosts() {
  try {
    const data = await api('/api/domains');
    domainCosts = {};
    data.domains.forEach((d) => {
      domainCosts[d.name || d.domain] = d.costGems;
    });
    updateOrderCostHint();
  } catch {
    orderCostHint.textContent = 'Could not load domain prices.';
  }
}

function updateOrderCostHint() {
  const domain = domainInput.value.trim();
  const cost = domainCosts[domain];
  orderCostHint.textContent = cost
    ? `Estimated cost: ${fmt(cost)} gems for ${domain}`
    : 'Select a domain to see gem cost.';
}

async function topupPackage(packageId) {
  const method = topupMethodSelect.value || wallet?.methods?.[0]?.id;
  if (!method) {
    topupResult.textContent = 'No payment methods configured.';
    return;
  }
  await runTopup({ method, packageId });
}

async function runTopup(body) {
  topupResult.textContent = 'Creating payment…';
  try {
    const result = await api('/api/topup', { method: 'POST', body: JSON.stringify(body) });

    if (result.billUrl) {
      topupResult.innerHTML = `Pay via Billplz (FPX/card/TnG): <a href="${result.billUrl}" target="_blank" rel="noopener">Open payment</a>`;
      window.open(result.billUrl, '_blank');
    } else if (result.instructions) {
      topupResult.textContent = [...result.instructions, `Payment #${result.paymentId}`].join(' · ');
    } else {
      topupResult.textContent = result.note || 'Payment created.';
    }
  } catch (err) {
    topupResult.textContent = err.message;
  }
}

async function createOrder(event) {
  event.preventDefault();
  const site = siteInput.value.trim();
  const domain = domainInput.value.trim();
  if (!site || !domain) return;

  orderForm.querySelector('button').disabled = true;
  try {
    await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ site, domain }),
    });
    await loadOrders();
    await loadWallet();
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = 'status-pill error';
  } finally {
    orderForm.querySelector('button').disabled = false;
  }
}

async function cancelOrder(id) {
  try {
    await api(`/api/orders/${id}`, { method: 'DELETE' });
    await loadOrders();
    await loadWallet();
  } catch (err) {
    liveStatus.textContent = err.message;
    liveStatus.className = 'status-pill error';
  }
}

async function initSession() {
  const urlToken = getTokenFromUrl();
  const savedToken = localStorage.getItem(STORAGE_KEY);
  const query = urlToken
    ? `?token=${encodeURIComponent(urlToken)}`
    : savedToken
      ? `?token=${encodeURIComponent(savedToken)}`
      : '';

  const session = await fetch(`/api/session${query}`).then((res) => res.json());
  setToken(session.token, false);
  tokenInput.value = token;

  if (urlToken || savedToken) tokenPanel.hidden = true;
}

function startAutoRefresh() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadOrders().catch(() => {
      liveStatus.textContent = 'Reconnecting…';
      liveStatus.className = 'status-pill error';
    });
    loadWallet().catch(() => {});
  }, refreshMs);
}

orderForm.addEventListener('submit', createOrder);
refreshBtn.addEventListener('click', () => {
  loadOrders();
  loadWallet();
});
domainInput.addEventListener('input', updateOrderCostHint);

customTopupBtn.addEventListener('click', () => {
  const amountMyr = parseFloat(customMyrInput.value);
  const method = topupMethodSelect.value;
  if (!amountMyr || !method) return;
  runTopup({ method, amountMyr });
});

tokenSave.addEventListener('click', async () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  setToken(value);
  try {
    await loadWallet();
    await loadOrders();
    startAutoRefresh();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    liveStatus.textContent = 'Invalid token';
    liveStatus.className = 'status-pill error';
  }
});

initSession()
  .then(loadConfig)
  .then(loadHealth)
  .then(loadWallet)
  .then(loadOrders)
  .then(startAutoRefresh)
  .catch((err) => {
    liveStatus.textContent = err.message;
    liveStatus.className = 'status-pill error';
  });

if (window.location.hash === '#topup' || new URLSearchParams(window.location.search).get('topup')) {
  document.getElementById('topup-panel')?.scrollIntoView({ behavior: 'smooth' });
}
