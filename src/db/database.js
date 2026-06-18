const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../config');

let db;

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
      received_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_orders_user_id ON email_orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_email_orders_status ON email_orders(status);
    CREATE INDEX IF NOT EXISTS idx_email_orders_hero_id ON email_orders(hero_id);
  `);

  return db;
}

module.exports = { getDb };
