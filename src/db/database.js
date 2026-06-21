const { MongoClient } = require("mongodb");
const { config } = require("../config");

let client = null;
let db = null;

const DB_NAME = "sms-mail";

async function connectDb() {
  if (db) return db;
  
  console.log("[DB] Connecting to MongoDB...");
  client = new MongoClient(config.mongoUri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  db = client.db(DB_NAME);

  // Drop old unique index on telegram_id if it exists (caused E11000 for web users with null)
  try {
    await db.collection("users").dropIndex("telegram_id_1");
    console.log("[DB] Dropped old unique index on users.telegram_id");
  } catch {}

  // Create indexes
  await Promise.all([
    db.collection("users").createIndex({ telegram_id: 1 }),
    db.collection("users").createIndex({ access_token: 1 }, { unique: true }),
    db.collection("email_orders").createIndex({ user_id: 1 }),
    db.collection("email_orders").createIndex({ hero_id: 1 }, { unique: true }),
    db.collection("email_orders").createIndex({ status: 1 }),
    db.collection("payments").createIndex({ user_id: 1 }),
    db.collection("payments").createIndex({ status: 1 }),
    db.collection("payments").createIndex({ provider: 1, provider_ref: 1 }),
    db.collection("gem_transactions").createIndex({ user_id: 1 }),
    db.collection("blocked_users").createIndex({ user_id: 1 }, { unique: true }),
    db.collection("app_config").createIndex({ key: 1 }, { unique: true }),
  ]);

  // Seed gem packages
  const pkgCount = await db.collection("gem_packages").countDocuments();
  if (pkgCount === 0) {
    await db.collection("gem_packages").insertMany([
      { name: "RM 5", gems: 0, price_myr: 5, sort_order: 1, active: 1 },
      { name: "RM 10", gems: 0, price_myr: 10, sort_order: 2, active: 1 },
      { name: "RM 25", gems: 0, price_myr: 25, sort_order: 3, active: 1 },
      { name: "RM 50", gems: 0, price_myr: 50, sort_order: 4, active: 1 },
      { name: "RM 100", gems: 0, price_myr: 100, sort_order: 5, active: 1 },
    ]);
  }

  console.log("[DB] MongoDB connected, database:", DB_NAME);
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not connected. Call connectDb() first.");
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("[DB] MongoDB connection closed");
  }
}

// Blocked users helpers
async function isUserBlocked(telegramId) {
  const d = getDb();
  const row = await d.collection("blocked_users").findOne({ user_id: Number(telegramId) });
  return !!row;
}

async function blockUser(telegramId, reason, blockedBy) {
  const d = getDb();
  await d.collection("blocked_users").updateOne(
    { user_id: Number(telegramId) },
    { $set: { reason: reason || "manual block", blocked_by: blockedBy || null, blocked_at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function unblockUser(telegramId) {
  const d = getDb();
  await d.collection("blocked_users").deleteOne({ user_id: Number(telegramId) });
}

async function listBlockedUsers() {
  const d = getDb();
  return d.collection("blocked_users").find().sort({ blocked_at: -1 }).limit(50).toArray();
}

async function saveUserPreference(telegramId, key, value) {
  const d = getDb();
  const val = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Only allow specific keys
  if (["preferred_country", "recent_services", "language"].includes(key)) {
    await d.collection("users").updateOne(
      { telegram_id: String(telegramId) },
      { $set: { [key]: val } }
    );
  }
}

async function getUserPreferences(telegramId) {
  const d = getDb();
  const row = await d.collection("users").findOne(
    { telegram_id: String(telegramId) },
    { projection: { preferred_country: 1, recent_services: 1, language: 1 } }
  );
  if (!row) return {};
  try {
    return {
      preferredCountry: row.preferred_country || null,
      recentServices: row.recent_services ? JSON.parse(row.recent_services) : [],
      language: row.language || "en",
    };
  } catch {
    return {};
  }
}

module.exports = {
  connectDb,
  getDb,
  closeDb,
  isUserBlocked,
  blockUser,
  unblockUser,
  listBlockedUsers,
  saveUserPreference,
  getUserPreferences,
};