const { getDb } = require('../db/database');

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    amountMyr: row.amount_myr,
    gems: row.gems,
    status: row.status,
    meta: row.meta ? JSON.parse(row.meta) : null,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

function createPayment(userId, { provider, amountMyr, gems, providerRef = null, meta = null }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO payments (user_id, provider, provider_ref, amount_myr, gems, status, meta)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(userId, provider, providerRef, amountMyr, gems, meta ? JSON.stringify(meta) : null);

  return getPaymentById(result.lastInsertRowid);
}

function getPaymentById(id) {
  const row = getDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  return mapPayment(row);
}

function getPaymentByProviderRef(provider, providerRef) {
  const row = getDb()
    .prepare('SELECT * FROM payments WHERE provider = ? AND provider_ref = ?')
    .get(provider, providerRef);
  return mapPayment(row);
}

function updatePayment(id, fields) {
  const db = getDb();
  const sets = [];
  const values = [];

  if (fields.status !== undefined) {
    sets.push('status = ?');
    values.push(fields.status);
  }
  if (fields.providerRef !== undefined) {
    sets.push('provider_ref = ?');
    values.push(fields.providerRef);
  }
  if (fields.paidAt !== undefined) {
    sets.push('paid_at = ?');
    values.push(fields.paidAt);
  }
  if (fields.meta !== undefined) {
    sets.push('meta = ?');
    values.push(JSON.stringify(fields.meta));
  }

  if (!sets.length) return getPaymentById(id);

  values.push(id);
  db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getPaymentById(id);
}

function listPayments(userId, { limit = 20 } = {}) {
  const rows = getDb()
    .prepare(`
      SELECT * FROM payments WHERE user_id = ?
      ORDER BY id DESC LIMIT ?
    `)
    .all(userId, limit);
  return rows.map(mapPayment);
}

function listPendingManualPayments({ limit = 50 } = {}) {
  const rows = getDb()
    .prepare(`
      SELECT p.*, u.telegram_id FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.provider IN ('manual_tng', 'manual_bank') AND p.status = 'pending'
      ORDER BY p.id ASC LIMIT ?
    `)
    .all(limit);
  return rows.map((row) => ({ ...mapPayment(row), telegramId: row.telegram_id }));
}

async function listPackages() {
  const { myrToGems, fetchUsdMyrRate } = require('../exchangeRate');
  const rows = getDb()
    .prepare('SELECT * FROM gem_packages WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all();

  return Promise.all(
    rows.map(async (row) => {
      const usdMyr = await fetchUsdMyrRate();
      const gems = myrToGems(row.price_myr, usdMyr);
      return {
        id: row.id,
        name: `${gems.toLocaleString()} Gems`,
        gems,
        priceMyr: row.price_myr,
        sortOrder: row.sort_order,
      };
    })
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
