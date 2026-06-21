const crypto = require("crypto");
const { getDb } = require("../db/database");

const WAIT_STATUSES = new Set(["WAIT", "PENDING", "1"]);

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function findUserByTelegramId(telegramId) {
  const d = getDb();
  const row = await d.collection("users").findOne({ telegram_id: String(telegramId) });
  return mapUser(row);
}

async function findUserByToken(token) {
  const d = getDb();
  const row = await d.collection("users").findOne({ access_token: token });
  return mapUser(row);
}

async function getOrCreateTelegramUser(telegramId) {
  const d = getDb();
  const existing = await findUserByTelegramId(telegramId);
  if (existing) return existing;

  const token = generateToken();
  const now = new Date().toISOString();
  const result = await d.collection("users").insertOne({
    telegram_id: String(telegramId),
    access_token: token,
    gems_balance: 0,
    created_at: now,
  });

  const newUser = mapUser({ _id: result.insertedId, telegram_id: String(telegramId), access_token: token, gems_balance: 0, created_at: now });

  // Merge any anonymous web users that have gems
  try {
    const webUsers = await d.collection("users").find({
      telegram_id: null,
      gems_balance: { $gt: 0 },
    }).toArray();

    for (const wu of webUsers) {
      if (wu.gems_balance > 0) {
        console.log(`[MERGE] Moving ${wu.gems_balance} gems from web user ${wu._id} to Telegram user ${telegramId}`);
        // Credit gems to Telegram user
        await d.collection("users").updateOne(
          { _id: result.insertedId },
          { $inc: { gems_balance: wu.gems_balance } }
        );
        // Insert transaction records
        await d.collection("gem_transactions").insertOne({
          user_id: newUser.id,
          amount: wu.gems_balance,
          type: "merge",
          ref_id: wu._id.toString(),
          balance_after: (newUser.gemsBalance || 0) + wu.gems_balance,
          note: `Merged from web user #${wu._id.toString().slice(-6)}`,
          created_at: now,
        });
        // Zero out web user
        await d.collection("users").updateOne(
          { _id: wu._id },
          { $set: { gems_balance: 0 } }
        );
        // Update payments to point to new user
        await d.collection("payments").updateMany(
          { user_id: wu._id.toString() },
          { $set: { user_id: newUser.id } }
        );
        newUser.gemsBalance = (newUser.gemsBalance || 0) + wu.gems_balance;
      }
    }
  } catch (e) {
    console.error("[MERGE] Failed to merge web users:", e.message);
  }

  return newUser;
}

async function getOrCreateWebUser(token) {
  const d = getDb();
  if (token) {
    const user = await findUserByToken(token);
    if (user) return user;
  }

  const newToken = generateToken();
  const now = new Date().toISOString();
  const result = await d.collection("users").insertOne({
    telegram_id: null,
    access_token: newToken,
    gems_balance: 0,
    created_at: now,
  });

  return mapUser({ _id: result.insertedId, telegram_id: null, access_token: newToken, gems_balance: 0, created_at: now });
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row._id ? row._id.toString() : row.id,
    telegramId: row.telegram_id,
    accessToken: row.access_token,
    gemsBalance: row.gems_balance ?? 0,
    createdAt: row.created_at,
  };
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row._id ? row._id.toString() : row.id,
    heroId: row.hero_id,
    site: row.site,
    domain: row.domain,
    email: row.email,
    status: row.status,
    value: row.value,
    message: row.message,
    cost: row.cost,
    currency: row.currency,
    gemsCharged: row.gems_charged,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function saveOrder(userId, order, { gemsCharged } = {}) {
  const d = getDb();
  const existing = await d.collection("email_orders").findOne({ hero_id: order.id || order.activationId || order.heroId });
  const now = new Date().toISOString();

  if (existing) {
    await d.collection("email_orders").updateOne(
      { _id: existing._id },
      {
        $set: {
          email: order.email || existing.email,
          status: order.status || existing.status,
          value: order.value || existing.value || null,
          message: order.message || existing.message || null,
          updated_at: now,
          received_at: order.receivedAt || existing.received_at || null,
          gems_charged: gemsCharged || existing.gems_charged,
        },
      }
    );
    const updated = await d.collection("email_orders").findOne({ _id: existing._id });
    return mapOrder(updated);
  }

  const result = await d.collection("email_orders").insertOne({
    user_id: userId,
    hero_id: order.id || order.activationId || order.heroId,
    site: order.site || "",
    domain: order.domain || "",
    email: order.email || null,
    status: order.status || "WAIT",
    value: order.value || null,
    message: order.message || null,
    cost: order.cost || 0,
    currency: order.currency || "USD",
    gems_charged: gemsCharged || 0,
    received_at: null,
    created_at: now,
    updated_at: now,
  });

  const newOrder = await d.collection("email_orders").findOne({ _id: result.insertedId });
  return mapOrder(newOrder);
}

function isWaiting(order) {
  if (!order) return false;
  return WAIT_STATUSES.has(order.status) && !order.value;
}

async function listWaitingOrders() {
  const d = getDb();
  const statuses = Array.from(WAIT_STATUSES);
  const rows = await d.collection("email_orders")
    .find({ status: { $in: statuses } })
    .sort({ created_at: 1 })
    .toArray();

  // Filter for those without a received value
  return rows.filter(row => !row.value).map(mapOrder);
}

async function listOrders(userId, { limit = 100 } = {}) {
  const d = getDb();
  const rows = await d.collection("email_orders")
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return rows.map(mapOrder);
}

async function getOrderById(orderId, userId) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let filter;
  try {
    filter = { _id: new ObjectId(String(orderId)), user_id: userId };
  } catch {
    filter = { hero_id: String(orderId), user_id: userId };
  }
  const row = await d.collection("email_orders").findOne(filter);
  return mapOrder(row);
}

function formatOrder(order) {
  const lines = [
    `Order #${order.id}`,
    `Service: ${order.site || "N/A"}`,
    `Domain: ${order.domain || "N/A"}`,
    `Status: ${order.status}`,
  ];
  if (order.email) lines.push(`Email: ${order.email}`);
  if (order.cost) lines.push(`Cost: ${order.cost} ${order.currency || "USD"}`);
  if (order.gemsCharged) lines.push(`Gems: ${order.gemsCharged}`);
  if (order.value) lines.push(`📨 Code: ${order.value}`);
  if (order.message) lines.push(`Message: ${order.message}`);
  return lines.join("\n");
}

function formatOrderList(orders) {
  return orders.map(formatOrder).join("\n\n");
}

module.exports = {
  findUserByTelegramId,
  findUserByToken,
  getOrCreateTelegramUser,
  getOrCreateWebUser,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
  isWaiting,
  listWaitingOrders,
};
