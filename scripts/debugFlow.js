/**
 * Debug script to run the full user → payment → admin → merge flow
 * without creating real orders or charging money.
 *
 * Usage (run from project root):
 *   node scripts/debugFlow.js <telegramId>
 *
 * The script will:
 *   1. Create an anonymous web user (or reuse existing token)
 *   2. Create a local manual top-up payment (no external charge)
 *   3. Use the local-only debug merge endpoint to get the Telegram token
 *   4. Approve the payment via the admin endpoint
 *   5. Print the final merged user object with debug logs.
 */

require('dotenv').config();

// Node 18+ provides a global fetch implementation
const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

function log(msg, data) {
  console.log(`[DEBUG] ${msg}`, data || '');
}

async function api(path, method = 'GET', body = null, token = null, extraHeaders = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
  const webToken = sessionInfo.token;
  log('Obtained web token from /api/session', webToken);

  // 2. Create a local manual top-up payment. This only creates a pending
  //    manual payment record; it does not charge or create an SMS order.
  const topup = await api('/api/topup', 'POST', {
    method: 'manual_bank',
    amountMyr: 5,
  }, webToken);
  log('Created manual top-up payment', topup);

  // 3. Merge web users into the Telegram user and get the Telegram token.
  //    This local-only endpoint is disabled in production.
  const mergeResult = await api('/api/debug/merge', 'POST', { telegramId: tgId }, null, {
    'x-admin-telegram-id': tgId,
  });
  const adminToken = mergeResult.user?.accessToken;
  log('Merge result', mergeResult);

  // 4. Approve the payment via admin endpoint using the Telegram user token.
  await api('/api/admin/approve-payment', 'POST', { paymentId: topup.paymentId }, adminToken);
  log('Admin approved payment');

  // 5. Print final wallet
  const wallet = await api('/api/wallet', 'GET', null, adminToken);
  log('Final wallet', wallet);
}

main().catch(err => {
  console.error('Script failed:', err.message);
  process.exit(1);
});