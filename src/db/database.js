const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../config');

let db;

function migrate(dbInstance) {
  const userCols = dbInstance.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'gems_balance')) {
    dbInstance.exec('ALTER TABLE users ADD COLUMN gems_balance INTEGER NOT NULL DEFAULT 0');
  }

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS gem_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gems INTEGER NOT NULL,
      price_myr REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_ref TEXT,
      amount_myr REAL NOT NULL,
      gems INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gem_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref_id INTEGER,
      balance_after INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider, provider_ref);
    CREATE INDEX IF NOT EXISTS idx_gem_transactions_user_id ON gem_transactions(user_id);
  `);

  const pkgCount = dbInstance.prepare('SELECT COUNT(*) AS c FROM gem_packages').get().c;
  if (pkgCount === 0) {
    const insert = dbInstance.prepare(`
      INSERT INTO gem_packages (name, gems, price_myr, sort_order) VALUES (?, ?, ?, ?)
    `);
    insert.run('RM 5', 0, 5, 1);
    insert.run('RM 10', 0, 10, 2);
    insert.run('RM 25', 0, 25, 3);
    insert.run('RM 50', 0, 50, 4);
    insert.run('RM 100', 0, 100, 5);
  }
}

function getDb() {
  if (db) return db;

  const dir = path.dirname(config.databasePath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      access_token TEXT NOT NULL UNIQUE,
      gems_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      hero_id TEXT NOT NULL UNIQUE,
      site TEXT NOT NULL,
      domain TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'WAIT',
      value TEXT,
      message TEXT,
      cost REAL,
      currency TEXT,
      gems_charged INTEGER,
      received_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_orders_user_id ON email_orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_email_orders_status ON email_orders(status);
    CREATE INDEX IF NOT EXISTS idx_email_orders_hero_id ON email_orders(hero_id);
  `);

  migrate(db);

  const orderCols = db.prepare('PRAGMA table_info(email_orders)').all();
  if (!orderCols.some((c) => c.name === 'gems_charged')) {
    db.exec('ALTER TABLE email_orders ADD COLUMN gems_charged INTEGER');
  }

  return db;
}

module.exports = { getDb };
