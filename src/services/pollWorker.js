const { config } = require('../config');
const { getEmail, normalizeEmailOrder } = require('./heroSms');
const { listWaitingOrders, saveOrder, isWaiting } = require('./mailStore');
const { notifyMailReceived } = require('./notifier');

let timer = null;
let running = false;

async function processOrder(order) {
  try {
    const remote = await getEmail(order.heroId);
    if (!remote) return null;

    const updated = saveOrder(order.userId || findUserIdForOrder(order.id), remote);
    const wasWaiting = isWaiting(order);
    const nowReceived = Boolean(updated?.value);

    if (wasWaiting && nowReceived) {
      await notifyMailReceived(updated, 'poll');
    }

    return updated;
  } catch (err) {
    console.error(`Poll failed for hero_id=${order.heroId}:`, err.message);
    return null;
  }
}

function findUserIdForOrder(orderId) {
  const { getDb } = require('../db/database');
  const row = getDb().prepare('SELECT user_id FROM email_orders WHERE id = ?').get(orderId);
  return row?.user_id;
}

async function pollOnce() {
  if (running) return;
  running = true;

  try {
    const waiting = listWaitingOrders();
    await Promise.all(waiting.map((order) => processOrder({ ...order, userId: findUserIdForOrder(order.id) })));
  } finally {
    running = false;
  }
}

function startPollWorker() {
  if (timer) return;

  pollOnce();
  timer = setInterval(pollOnce, config.pollIntervalMs);
  console.log(`Mail poll worker started (every ${config.pollIntervalMs}ms)`);
}

function stopPollWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object') return null;

  const nested = body.data && typeof body.data === 'object' ? body.data : body;

  const heroId = nested.emailId ?? nested.id ?? nested.activationId ?? body.emailId ?? body.id ?? body.activationId;
  if (!heroId) return null;

  return normalizeEmailOrder({
    id: heroId,
    site: nested.site ?? body.site,
    domain: nested.domain ?? body.domain,
    email: nested.email ?? body.email,
    status: nested.status ?? body.status,
    value: nested.value ?? nested.code ?? body.value ?? body.code,
    message: nested.message ?? nested.text ?? body.message ?? body.text,
    cost: nested.cost ?? body.cost,
    currency: nested.currency ?? body.currency,
    date: nested.receivedAt ?? nested.date ?? body.receivedAt,
  });
}

async function handleWebhookPayload(body) {
  const order = parseWebhookPayload(body);
  if (!order?.heroId) {
    return { ok: false, reason: 'unrecognized_payload' };
  }

  const { getDb } = require('../db/database');
  const existing = getDb().prepare('SELECT * FROM email_orders WHERE hero_id = ?').get(order.heroId);

  if (!existing) {
    return { ok: true, ignored: true, reason: 'unknown_order' };
  }

  const wasWaiting = isWaiting({ status: existing.status, value: existing.value });
  const updated = saveOrder(existing.user_id, order);

  if (wasWaiting && updated?.value) {
    await notifyMailReceived(updated, 'webhook');
  }

  return { ok: true, order: updated };
}

module.exports = {
  startPollWorker,
  stopPollWorker,
  pollOnce,
  handleWebhookPayload,
  parseWebhookPayload,
};
