const { config } = require("../../config");
const { createPayment, updatePayment } = require("./store");

// Billplz processing fee charged to the consumer (e.g. 3.5% = 0.035)
const BILLPLZ_PROCESSING_FEE = 0.035;

function calculateBillplzAmount(netMyr) {
  // Consumer pays: net amount + processing fee
  // Formula: total = netMyr / (1 - fee) so you still receive netMyr after fee
  // OR simpler: total = netMyr * (1 + fee) so consumer pays fee on top
  const total = netMyr * (1 + BILLPLZ_PROCESSING_FEE);
  return Math.round(total * 100); // return in cents (sen)
}

async function createBill(bill) {
  const url = `${config.billplzApiUrl}/v3/bills`;
  const auth = Buffer.from(`${config.billplzApiKey}:`).toString("base64");

  const amountCents = calculateBillplzAmount(bill.amountMyr);
  const body = new URLSearchParams({
    collection_id: config.billplzCollectionId,
    description: bill.description,
    email: bill.email || "customer@telegram.local",
    name: bill.name || "Customer",
    amount: String(amountCents),
    callback_url: bill.callbackUrl,
    redirect_url: bill.redirectUrl || bill.callbackUrl,
    reference_1_label: "Payment ID",
    reference_1: String(bill.paymentId),
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || data?.message || "Billplz request failed");
  }
  return data;
}

async function startBillplzTopup(userId, { amountMyr, gems, description }) {
  if (!config.billplzApiKey || !config.billplzCollectionId) {
    throw new Error(
      "Billplz is not configured (BILLPLZ_API_KEY, BILLPLZ_COLLECTION_ID)",
    );
  }

  const payment = createPayment(userId, {
    provider: "billplz",
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

  const crypto = require("crypto");
  const keys = Object.keys(data)
    .filter((k) => k !== "x_signature")
    .sort();
  const str = keys.map((k) => `${k}${data[k]}`).join("|");
  const expected = crypto
    .createHmac("sha256", config.billplzXSignatureKey)
    .update(str)
    .digest("hex");

  return expected === signature;
}

module.exports = {
  startBillplzTopup,
  verifyBillplzSignature,
};
