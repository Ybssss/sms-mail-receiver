const { config } = require('../../config');
const { createPayment, updatePayment } = require('./store');

async function createBill(bill) {
  const url = `${config.billplzApiUrl}/v3/bills`;
  const auth = Buffer.from(`${config.billplzApiKey}:`).toString('base64');

  const body = new URLSearchParams({
    collection_id: config.billplzCollectionId,
    description: bill.description,
    email: bill.email || 'customer@telegram.local',
    name: bill.name || 'Customer',
    amount: String(Math.round(bill.amountMyr * 100)),
    callback_url: bill.callbackUrl,
    redirect_url: bill.redirectUrl || bill.callbackUrl,
    reference_1_label: 'Payment ID',
    reference_1: String(bill.paymentId),
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || data?.message || 'Billplz request failed');
  }
  return data;
}

async function startBillplzTopup(userId, { amountMyr, gems, description }) {
  if (!config.billplzApiKey || !config.billplzCollectionId) {
    throw new Error('Billplz is not configured (BILLPLZ_API_KEY, BILLPLZ_COLLECTION_ID)');
  }

  const payment = createPayment(userId, {
    provider: 'billplz',
    amountMyr,
    gems,
  });

  const callbackUrl = `${config.webappUrl}/webhook/billplz`;
  const redirectUrl = `${config.webappUrl}/?token={token}&topup=success`;

  const bill = await createBill({
    paymentId: payment.id,
    amountMyr,
    description: description || `Top up ${gems.toLocaleString()} gems`,
    callbackUrl,
    redirectUrl,
  });

  updatePayment(payment.id, {
    providerRef: bill.id,
    meta: { billUrl: bill.url },
  });

  return {
    paymentId: payment.id,
    billUrl: bill.url,
    billId: bill.id,
  };
}

function verifyBillplzSignature(data, signature) {
  if (!config.billplzXSignatureKey) return true;

  const crypto = require('crypto');
  const keys = Object.keys(data)
    .filter((k) => k !== 'x_signature')
    .sort();
  const str = keys.map((k) => `${k}${data[k]}`).join('|');
  const expected = crypto
    .createHmac('sha256', config.billplzXSignatureKey)
    .update(str)
    .digest('hex');

  return expected === signature;
}

module.exports = {
  startBillplzTopup,
  verifyBillplzSignature,
};
