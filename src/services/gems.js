const { getDb } = require('../db/database');

function getUserBalance(userId) {
  const row = getDb().prepare('SELECT gems_balance FROM users WHERE id = ?').get(userId);
  return row?.gems_balance ?? 0;
}

function creditGems(userId, amount, type, refId = null, note = null) {
  if (amount <= 0) throw new Error('Credit amount must be positive');

  const db = getDb();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT gems_balance FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found');

    const balanceAfter = user.gems_balance + amount;
    db.prepare('UPDATE users SET gems_balance = ? WHERE id = ?').run(balanceAfter, userId);
    db.prepare(`
      INSERT INTO gem_transactions (user_id, amount, type, ref_id, balance_after, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, amount, type, refId, balanceAfter, note);

    return balanceAfter;
  });

  return tx();
}

function debitGems(userId, amount, type, refId = null, note = null) {
  if (amount <= 0) throw new Error('Debit amount must be positive');

  const db = getDb();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT gems_balance FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found');
    if (user.gems_balance < amount) {
      throw new Error(`Insufficient gems: need ${amount}, have ${user.gems_balance}`);
    }

    const balanceAfter = user.gems_balance - amount;
    db.prepare('UPDATE users SET gems_balance = ? WHERE id = ?').run(balanceAfter, userId);
    db.prepare(`
      INSERT INTO gem_transactions (user_id, amount, type, ref_id, balance_after, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, -amount, type, refId, balanceAfter, note);

    return balanceAfter;
  });

  return tx();
}

function listTransactions(userId, { limit = 50 } = {}) {
  const rows = getDb()
    .prepare(`
      SELECT * FROM gem_transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(userId, limit);

  return rows.map((row) => ({
    id: row.id,
    amount: row.amount,
    type: row.type,
    refId: row.ref_id,
    balanceAfter: row.balance_after,
    note: row.note,
    createdAt: row.created_at,
  }));
}

function formatGems(n) {
  return Number(n).toLocaleString('en-MY');
}

module.exports = {
  getUserBalance,
  creditGems,
  debitGems,
  listTransactions,
  formatGems,
};
