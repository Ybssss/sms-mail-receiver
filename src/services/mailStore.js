const crypto = require('crypto');
const { getDb } = require('../db/database');

const WAIT_STATUSES = new Set(['WAIT', 'PENDING', '1']);

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function findUserByTelegramId(telegramId) {
  const row = getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  return mapUser(row);
}

function findUserByToken(token) {
  const row = getDb().prepare('SELECT * FROM users WHERE access_token = ?').get(token);
  return mapUser(row);
}

function getOrCreateTelegramUser(telegramId) {
  const db = getDb();
  const existing = findUserByTelegramId(telegramId);
  if (existing) return existing;

  const token = generateToken();
  const result = db
    .prepare('INSERT INTO users (telegram_id, access_token) VALUES (?, ?)')
    .run(String(telegramId), token);

  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
}

function getOrCreateWebUser(token) {
  const db = getDb();
  if (token) {
    const user = findUserByToken(token);
    if (user) return user;
  }

  const newToken = generateToken();
  const result = db
    .prepare('INSERT INTO users (telegram_id, access_token) VALUES (NULL, ?)')
    .run(newToken);

  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    telegramId: row.telegram_id,
    accessToken: row.access_token,
    gemsBalance: row.gems_balance ?? 0,
    createdAt: row.created_at,
  };
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
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

function saveOrder(userId, order, { gemsCharged } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM email_orders WHERE hero_id = ?').get(order.heroId);

  if (existing) {
    db.prepare(`
      UPDATE email_orders
      SET email = ?, status = ?, value = ?, message = ?, cost = ?, currency = ?,
          gems_charged = COALESCE(?, gems_charged),
          received_at = COALESCE(?, received_at), updated_at = datetime('now')
      WHERE hero_id = ?
    `).run(
      order.email || existing.email,
      order.status,
      order.value,
      order.message,
      order.cost,
      order.currency,
      gemsCharged ?? existing.gems_charged,
      order.value ? new Date().toISOString() : null,
      order.heroId
    );
    return getOrderByHeroId(order.heroId);
  }

  const result = db.prepare(`
    INSERT INTO email_orders (user_id, hero_id, site, domain, email, status, value, message, cost, currency, gems_charged, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    order.heroId,
    order.site,
    order.domain,
    order.email || null,
    order.status,
    order.value,
    order.message,
    order.cost,
    order.currency,
    gemsCharged ?? null,
    order.value ? new Date().toISOString() : null
  );

  return mapOrder(db.prepare('SELECT * FROM email_orders WHERE id = ?').get(result.lastInsertRowid));
}

function getOrderByHeroId(heroId) {
  const row = getDb().prepare('SELECT * FROM email_orders WHERE hero_id = ?').get(String(heroId));
  return mapOrder(row);
}

function getOrderById(id, userId) {
  const row = getDb()
    .prepare('SELECT * FROM email_orders WHERE id = ? AND user_id = ?')
    .get(id, userId);
  return mapOrder(row);
}

function listOrders(userId, { limit = 50 } = {}) {
  const rows = getDb()
    .prepare(`
      SELECT * FROM email_orders
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(userId, limit);

  return rows.map(mapOrder);
}

function listWaitingOrders() {
  const rows = getDb()
    .prepare(`
      SELECT * FROM email_orders
      WHERE status IN ('WAIT', 'PENDING', '1') AND (value IS NULL OR value = '')
      ORDER BY id ASC
    `)
    .all();

  return rows.map(mapOrder);
}

function isWaiting(order) {
  if (!order) return false;
  if (order.value) return false;
  return WAIT_STATUSES.has(String(order.status).toUpperCase());
}

function formatOrder(order) {
  if (!order) return 'Order not found.';
  const lines = [
    `#${order.id} · Hero ID ${order.heroId}`,
    `Email: ${order.email || 'pending'}`,
    `Site: ${order.site} · Domain: ${order.domain}`,
    `Status: ${order.status}`,
  ];
  if (order.value) lines.push(`Code/value: ${order.value}`);
  if (order.message) lines.push(`Message: ${order.message}`);
  return lines.join('\n');
}

function formatOrderList(orders) {
  if (!orders.length) return 'No email orders yet.';
  return orders.map((order) => {
    const icon = order.value ? '✅' : '⏳';
    return `${icon} #${order.id} ${order.email || order.domain} — ${order.status}${order.value ? ` → ${order.value}` : ''}`;
  }).join('\n');
}

module.exports = {
  findUserByToken,
  getOrCreateTelegramUser,
  getOrCreateWebUser,
  saveOrder,
  getOrderByHeroId,
  getOrderById,
  listOrders,
  listWaitingOrders,
  isWaiting,
  formatOrder,
  formatOrderList,
};
