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

  // Merge any anonymous web users that have gems into this Telegram user
  // Runs for both new AND existing users (since existing users may have topped up via web)
  await mergeWebUserBalance(telegramId);

  if (existing) {
    // Re-read balance after merge
    const updated = await findUserByTelegramId(telegramId);
    return updated || existing;
  }

  const token = generateToken();
  const now = new Date().toISOString();
  const result = await d.collection("users").insertOne({
    telegram_id: String(telegramId),
    access_token: token,
    gems_balance: 0,
    created_at: now,
  });

  // Re-merge after creating (captures race condition where web user was created between our two merge runs)
  await mergeWebUserBalance(telegramId);

  const finalUser = await findUserByTelegramId(telegramId);
  return finalUser || mapUser({ _id: result.insertedId, telegram_id: String(telegramId), access_token: token, gems_balance: 0, created_at: now });
}

async function mergeWebUserBalance(telegramId) {
  const d = getDb();
  try {
    const tgUser = await d.collection("users").findOne({ telegram_id: String(telegramId) });
    if (!tgUser) {
      console.log("[MERGE] No TG user found for telegram_id:", telegramId);
      return;
    }
    const tgUserId = tgUser._id.toString();
    console.log("[MERGE] Starting merge for TG user:", { tgUserId, telegramId, tgBalance: tgUser.gems_balance });

    // Find web users (any with telegram_id: null)
    const webUsers = await d.collection("users").find({ telegram_id: null }).toArray();
    console.log("[MERGE] Found", webUsers.length, "web users (telegram_id: null)");
    const now = new Date().toISOString();
    let totalMerged = 0;

    let canonicalWebUserId = null;

    for (const wu of webUsers) {
      const wuId = wu._id.toString();

      // Always reassign ALL payments from this web user to the Telegram user,
      // even if there's nothing to credit yet (handles pending payments that
      // will be approved later).
      const allPayments = await d.collection("payments").find({
        user_id: wuId,
      }).toArray();

      if (allPayments.length > 0 || (wu.gems_balance || 0) > 0) {
        // Reassign all payments (paid, pending, cancelled) to Telegram user
        await d.collection("payments").updateMany(
          { user_id: wuId },
          { $set: { user_id: tgUserId } }
        );

        // Calculate gems to credit: the current balance already reflects
        // gems credited from any paid payments, so we only need the balance.
        // Atomically zero the web user's balance — only one concurrent caller
        // will see gems_balance > 0 and succeed.
        const zeroResult = await d.collection("users").findOneAndUpdate(
          { _id: wu._id, gems_balance: { $gt: 0 } },
          { $set: { gems_balance: 0 } },
          { returnDocument: "before" }
        );
        const gemsToCredit = (zeroResult?.gems_balance || 0);

        if (gemsToCredit > 0) {
          const paidCount = allPayments.filter(p => p.status === "paid").length;
          console.log(`[MERGE] Moving ${gemsToCredit} gems from web user ${wuId} to TG user ${telegramId} (balance: ${gemsToCredit}, paid payments: ${paidCount}, total payments: ${allPayments.length})`);

          // Credit gems to Telegram user
          await d.collection("users").updateOne(
            { _id: tgUser._id },
            { $inc: { gems_balance: gemsToCredit } }
          );

          // Record transaction
          const updatedTg = await d.collection("users").findOne({ _id: tgUser._id });
          await d.collection("gem_transactions").insertOne({
            user_id: tgUserId,
            amount: gemsToCredit,
            type: "merge",
            ref_id: wuId,
            balance_after: updatedTg?.gems_balance || 0,
            note: `Merged ${paidCount} paid payments + balance from web user #${wuId.slice(-6)}`,
            created_at: now,
          });
          totalMerged += gemsToCredit;
        } else {
          console.log(`[MERGE] Reassigning ${allPayments.length} pending payment(s) from web user ${wuId} to TG user ${telegramId} (no paid payments to credit yet)`);
        }

        // Unique access_token means only one merged web document can keep the TG token.
        // Keep the first relevant web user as the canonical web identity; delete the rest
        // after moving their payments/balance so repeated merges are idempotent.
        if (!canonicalWebUserId) {
          canonicalWebUserId = wuId;
          console.log(`[MERGE] Marking web user ${wuId} as merged (telegram_id set, token kept original)`);
          await d.collection("users").updateOne(
            { _id: wu._id },
            { $set: { telegram_id: String(telegramId), gems_balance: 0 } }
          );
        } else {
          console.log(`[MERGE] Deleting duplicate merged web user ${wuId} after moving ${allPayments.length} payment(s) and ${gemsToCredit} gems`);
          await d.collection("users").deleteOne({ _id: wu._id });
        }

      }
    }

    if (totalMerged > 0) {
      console.log(`[MERGE] Total merged: ${totalMerged} gems for TG user ${telegramId}`);
    }
  } catch (e) {
    console.error("[MERGE] Failed to merge web users:", e.message, e.stack);
  }
}

async function getOrCreateWebUser(token) {
  const d = getDb();
  if (token) {
    const user = await findUserByToken(token);
    if (user) return user;
  }

  // Check if there's already a Telegram user for this device (e.g. from sessionStorage)
  // This prevents creating a web user when the user already has a TG user.
  // We can't reliably detect this here, but the merge will catch it.
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
  mergeWebUserBalance,
  saveOrder,
  listOrders,
  getOrderById,
  formatOrder,
  formatOrderList,
  isWaiting,
  listWaitingOrders,
};