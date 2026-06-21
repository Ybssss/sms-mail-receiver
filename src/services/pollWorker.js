const { config } = require("../config");
const { getEmail, normalizeEmailOrder } = require("./heroSms");
const { listWaitingOrders, saveOrder, isWaiting } = require("./mailStore");
const { notifyMailReceived } = require("./notifier");

let timer = null;
let running = false;

async function findUserIdForOrder(orderId) {
  const { getDb } = require("../db/database");
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let filter;
  try {
    filter = { _id: new ObjectId(String(orderId)) };
  } catch {
    filter = { hero_id: String(orderId) };
  }
  const row = await d.collection("email_orders").findOne(filter, { projection: { user_id: 1 } });
  return row?.user_id || null;
}

async function processOrder(order) {
  try {
    const remote = await getEmail(order.heroId);
    if (!remote) return null;

    const userId = order.userId || await findUserIdForOrder(order.id);
    if (!userId) return null;

    const updated = await saveOrder(userId, remote);
    const wasWaiting = isWaiting(order);
    const nowReceived = Boolean(updated?.value);

    if (wasWaiting && nowReceived) {
      await notifyMailReceived(updated, "poll");
    }

    return updated;
  } catch (err) {
    console.error(`Poll failed for hero_id=${order.heroId}:`, err.message);
    return null;
  }
}

async function pollOnce() {
  if (running) return;
  running = true;

  try {
    const waiting = await listWaitingOrders();
    if (waiting.length > 0) {
      await Promise.all(waiting.map((order) => processOrder(order)));
    }
  } finally {
    running = false;
  }
}

function startPollWorker() {
  if (timer) return;

  pollOnce().catch((err) => console.error("Initial poll failed:", err.message));
  timer = setInterval(() => pollOnce().catch(() => {}), config.pollIntervalMs);
  console.log(`Mail poll worker started (every ${config.pollIntervalMs}ms)`);
}

function stopPollWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function parseWebhookPayload(body) {
  if (!body || typeof body !== "object") return null;

  const nested = body.data && typeof body.data === "object" ? body.data : body;

  const heroId =
    nested.emailId ??
    nested.id ??
    nested.activationId ??
    body.emailId ??
    body.id ??
    body.activationId;
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
    return { ok: false, reason: "unrecognized_payload" };
  }

  const { getDb } = require("../db/database");
  const d = getDb();
  const existing = await d.collection("email_orders").findOne({ hero_id: order.heroId });

  if (!existing) {
    return { ok: true, ignored: true, reason: "unknown_order" };
  }

  const wasWaiting = isWaiting({ status: existing.status, value: existing.value });
  const updated = await saveOrder(existing.user_id, order);

  if (wasWaiting && updated?.value) {
    await notifyMailReceived(updated, "webhook");
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