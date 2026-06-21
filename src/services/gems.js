const { getDb } = require("../db/database");

async function getUserBalance(userId) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  const uid = typeof userId === "string" ? userId : userId?.toString?.();
  const filter = uid?.length === 24 ? { _id: new ObjectId(uid) } : { _id: uid };
  const user = await d.collection("users").findOne(filter, { projection: { gems_balance: 1 } });
  return user?.gems_balance ?? 0;
}

async function setUserBalance(userId, newBalance) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  const filter = getObjectIdFilter(userId);
  await d.collection("users").updateOne(filter, { $set: { gems_balance: newBalance } });
}

function getObjectIdFilter(userId) {
  const { ObjectId } = require("mongodb");
  const uid = typeof userId === "string" ? userId : userId?.toString?.();
  if (uid?.length === 24) {
    try { return { _id: new ObjectId(uid) }; } catch {}
  }
  return { _id: uid };
}

async function creditGems(userId, amount, type, refId, note) {
  const d = getDb();
  const filter = getObjectIdFilter(userId);
  const user = await d.collection("users").findOne(filter);

  if (!user) throw new Error("User not found");

  const newBalance = (user.gems_balance || 0) + amount;
  const now = new Date().toISOString();

  await d.collection("users").updateOne(filter, { $set: { gems_balance: newBalance } });
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

async function listTransactions(userId, { limit = 50 } = {}) {
  const d = getDb();
  return d.collection("gem_transactions")
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
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