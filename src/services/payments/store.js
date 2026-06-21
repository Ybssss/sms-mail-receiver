const { getDb } = require("../../db/database");

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row._id ? row._id.toString() : row.id,
    userId: row.user_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    amountMyr: row.amount_myr,
    gems: row.gems,
    status: row.status,
    meta: row.meta || null,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

async function createPayment(userId, { provider, amountMyr, gems, providerRef = null, meta = null }) {
  const d = getDb();
  const now = new Date().toISOString();
  const result = await d.collection("payments").insertOne({
    user_id: userId,
    provider,
    provider_ref: providerRef,
    amount_myr: amountMyr,
    gems,
    status: "pending",
    meta,
    created_at: now,
    paid_at: null,
  });
  return getPaymentById(result.insertedId.toString());
}

async function getPaymentById(id) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let filter;
  try { filter = { _id: new ObjectId(String(id)) }; } catch { filter = { _id: String(id) }; }
  const row = await d.collection("payments").findOne(filter);
  return mapPayment(row);
}

async function getPaymentByProviderRef(provider, providerRef) {
  const d = getDb();
  const row = await d.collection("payments").findOne({ provider, provider_ref: providerRef });
  return mapPayment(row);
}

async function updatePayment(id, fields) {
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let filter;
  try { filter = { _id: new ObjectId(String(id)) }; } catch { filter = { _id: String(id) }; }

  const set = {};
  if (fields.status !== undefined) set.status = fields.status;
  if (fields.providerRef !== undefined) set.provider_ref = fields.providerRef;
  if (fields.paidAt !== undefined) set.paid_at = fields.paidAt;
  if (fields.meta !== undefined) set.meta = fields.meta;

  if (Object.keys(set).length > 0) {
    await d.collection("payments").updateOne(filter, { $set: set });
  }
  return getPaymentById(id);
}

async function listPayments(userId, { limit = 20 } = {}) {
  const d = getDb();
  const rows = await d.collection("payments")
    .find({ user_id: userId })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  return rows.map(mapPayment);
}

async function listPendingManualPayments({ limit = 50 } = {}) {
  const d = getDb();
  const rows = await d.collection("payments").aggregate([
    { $match: { provider: { $in: ["manual_tng", "manual_bank"] }, status: { $in: ["pending", "pending_review"] } } },
    { $lookup: { from: "users", localField: "user_id", foreignField: "telegram_id", as: "userDocs" } },
    { $unwind: { path: "$userDocs", preserveNullAndEmptyArrays: true } },
    { $sort: { _id: 1 } },
    { $limit: limit },
  ]).toArray();

  return rows.map((row) => ({
    ...mapPayment(row),
    telegramId: row.userDocs?.telegram_id || null,
  }));
}

async function listPackages() {
  const d = getDb();
  const rows = await d.collection("gem_packages")
    .find({ active: 1 })
    .sort({ sort_order: 1 })
    .toArray();

  const { myrToGems, fetchUsdMyrRate } = require("../exchangeRate");

  return Promise.all(
    rows.map(async (row) => {
      const usdMyr = await fetchUsdMyrRate();
      const gems = myrToGems(row.price_myr, usdMyr);
      return {
        id: row._id ? row._id.toString() : row.id,
        name: `${gems.toLocaleString()} Gems`,
        gems,
        priceMyr: row.price_myr,
        sortOrder: row.sort_order,
      };
    }),
  );
}

module.exports = {
  createPayment,
  getPaymentById,
  getPaymentByProviderRef,
  updatePayment,
  listPayments,
  listPendingManualPayments,
  listPackages,
  mapPayment,
};