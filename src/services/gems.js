const { getDb } = require("../db/database");

async function getUserBalance(userId) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  const uid = typeof userId === "string" ? userId : userId?.toString?.();
  const filter = uid?.length === 24 ? { _id: new ObjectId(uid) } : { _id: uid };
  const user = await d
    .collection("users")
    .findOne(filter, { projection: { gems_balance: 1, telegram_id: 1 } });
  console.log(
    "[GEMS] getUserBalance:",
    JSON.stringify({
      userId: uid,
      userFound: !!user,
      balance: user?.gems_balance,
      telegramId: user?.telegram_id,
    }),
  );
  return user?.gems_balance ?? 0;
}

async function setUserBalance(userId, newBalance) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  const filter = getObjectIdFilter(userId);
  await d
    .collection("users")
    .updateOne(filter, { $set: { gems_balance: newBalance } });
}

function getObjectIdFilter(userId) {
  const { ObjectId } = require("mongodb");
  const uid = typeof userId === "string" ? userId : userId?.toString?.();
  if (uid?.length === 24) {
    try {
      return { _id: new ObjectId(uid) };
    } catch {}
  }
  return { _id: uid };
}

async function creditGems(userId, amount, type, refId, note) {
  const d = getDb();
  const filter = getObjectIdFilter(userId);
  const user = await d.collection("users").findOne(filter);

  console.log("[GEMS] creditGems:", {
    userId,
    amount,
    filter,
    userFound: !!user,
    telegramId: user?.telegram_id,
    oldBalance: user?.gems_balance,
  });

  if (!user) throw new Error("User not found");

  const newBalance = (user.gems_balance || 0) + amount;
  const now = new Date().toISOString();

  await d
    .collection("users")
    .updateOne(filter, { $set: { gems_balance: newBalance } });
  console.log("[GEMS] creditGems updated:", {
    userId,
    newBalance,
    telegramId: user.telegram_id,
  });
  await d.collection("gem_transactions").insertOne({
    user_id: userId,
    amount,
    type,
    ref_id: refId || null,
    balance_after: newBalance,
    note: note || "",
    created_at: now,
  });

  return { balance: newBalance };
}

async function debitGems(userId, amount, type, refId, note) {
  return creditGems(userId, -amount, type, refId, note);
}

async function listTransactions(
  userId,
  { limit = 20, page = 1, type = null } = {},
) {
  const d = getDb();
  const filter = { user_id: userId };
  if (type && type !== "all") {
    filter.type = type;
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    d
      .collection("gem_transactions")
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    d.collection("gem_transactions").countDocuments(filter),
  ]);
  return {
    transactions: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

function formatGems(gems) {
  return Number(gems).toLocaleString("en-MY");
}

// ── SQLite compatibility shims ──────────────────────────────────
async function getUserBalanceSync(userId) {
  return getUserBalance(userId);
}

module.exports = {
  getUserBalance,
  setUserBalance,
  creditGems,
  debitGems,
  listTransactions,
  formatGems,
  getUserBalanceSync,
};
