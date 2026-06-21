/**
 * Debug script to run the full user → payment → admin → merge flow
 * without creating real orders or charging money.
 *
 * Usage (run from project root):
 *   node scripts/debugFlow.js <telegramId>
 *
 * The script will:
 *   1. Create an anonymous web user (or reuse existing token)
 *   2. Create a mock payment with amount 0 (so no real charge)
 *   3. Approve the payment via the admin endpoint (using bot token)
 *   4. Call the telegram-auth endpoint to merge balances
 *   5. Print the final merged user object with debug logs.
 */

require('dotenv').config();

// Node 18+ provides a global fetch implementation
const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function log(msg, data) {
  console.log(`[DEBUG] ${msg}`, data || '');
}

async function api(path, method = 'GET', body = null, token = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  log(`Calling ${method} ${path}`, body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[ERROR] ${method} ${path} failed:`, data.error || res.statusText);
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  log(`Response from ${path}`, data);
  return data;
}

async function main() {
  const tgId = process.argv[2];
  if (!tgId) {
    console.error('Please provide a Telegram user ID as argument');
    process.exit(1);
  }

  // 1. Get or create a web user token via the existing /api/session endpoint.
  //    /api/session creates a new anonymous web user when no token query is provided.
  const sessionInfo = await api('/api/session', 'GET');
  const token = sessionInfo.token;
  log('Obtained web token from /api/session', token);

  // 2. Create a mock payment (amount 0, provider "debug")
  const payment = await api('/api/payments', 'POST', {
    amountMyr: 0,
    provider: 'debug',
    providerRef: `debug-${Date.now()}`,
    status: 'paid',
  }, token);
  log('Created mock payment', payment);

  // 3. Approve the payment via admin endpoint (using bot token)
  await api('/api/admin/approve-payment', 'POST', { paymentId: payment._id }, BOT_TOKEN);
  log('Admin approved payment');

  // 4. Trigger merge via telegram-auth endpoint
  // The telegram-auth endpoint expects initData; we simulate minimal initData.
  const fakeInitData = new URLSearchParams({
    id: tgId,
    first_name: 'Test',
    auth_date: Math.floor(Date.now() / 1000).toString(),
    hash: 'invalidhash',
  }).toString();

  const mergeResult = await api('/api/telegram-auth', 'POST', fakeInitData, token);
  log('Merge result', mergeResult);
}

main().catch(err => {
  console.error('Script failed:', err.message);
  process.exit(1);
});