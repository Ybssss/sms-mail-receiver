const STORAGE_KEY = 'hero_mail_token';

const orderForm = document.getElementById('order-form');
const siteInput = document.getElementById('site-input');
const domainInput = document.getElementById('domain-input');
const ordersList = document.getElementById('orders-list');
const emptyState = document.getElementById('empty-state');
const liveStatus = document.getElementById('live-status');
const pollIntervalEl = document.getElementById('poll-interval');
const keepaliveStatusEl = document.getElementById('keepalive-status');
const webhookUrlEl = document.getElementById('webhook-url');
const refreshBtn = document.getElementById('refresh-btn');
const tokenPanel = document.getElementById('token-panel');
const tokenInput = document.getElementById('token-input');
const tokenSave = document.getElementById('token-save');
const telegramLink = document.getElementById('telegram-link');

let token = '';
let pollTimer = null;
let refreshMs = 2000;

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
    meta.textContent = `#${order.id} · ${order.site} · Hero ID ${order.heroId}`;

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
  const keep = health.keepAlive || {};
  keepaliveStatusEl.textContent = keep.lastPingOk ? 'OK' : 'Check logs';
  pollIntervalEl.textContent = `${health.pollIntervalMs || refreshMs}ms`;
}

async function loadConfig() {
  const config = await fetch('/api/config').then((res) => res.json());
  webhookUrlEl.textContent = config.webhookUrl || '—';
  refreshMs = config.pollIntervalMs || 2000;
  pollIntervalEl.textContent = `${refreshMs}ms`;

  if (config.defaultSite) siteInput.value = config.defaultSite;
  if (config.defaultDomain) domainInput.value = config.defaultDomain;
  if (config.botUsername) telegramLink.href = `https://t.me/${config.botUsername}`;
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
  }, refreshMs);
}

orderForm.addEventListener('submit', createOrder);
refreshBtn.addEventListener('click', () => loadOrders());

tokenSave.addEventListener('click', async () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  setToken(value);
  try {
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
  .then(loadOrders)
  .then(startAutoRefresh)
  .catch((err) => {
    liveStatus.textContent = err.message;
    liveStatus.className = 'status-pill error';
  });
