const { config } = require("../../config");
const {
  createPayment,
  getPaymentById,
  getPaymentByProviderRef,
  updatePayment,
  listPendingManualPayments,
  listPackages,
} = require("./store");
const { creditGems, getUserBalance } = require("../gems");
const { getExchangeInfo, fetchUsdMyrRate, gemsPerMyr } = require("../exchangeRate");
const { startManualTopup } = require("./manual");

async function createTopup(userId, { method, packageId, amountMyr }) {
  // Validate method
  if (method === "billplz" && !config.allowBillplz) {
    throw new Error("Billplz is not enabled");
  }
  if ((method === "manual_tng" || method === "manual_bank") && !config.allowManualPayments) {
    throw new Error("Manual payments are not enabled");
  }
  if (method === "telegram_stars") {
    throw new Error("Stars payments are only available inside Telegram");
  }

  if (method === "billplz") {
    const { createBill } = require("./billplz");
    if (!amountMyr || amountMyr < config.minTopupMyr) {
      throw new Error(`Minimum top-up is RM ${config.minTopupMyr}`);
    }
    const exchange = await getExchangeInfo();
    const gems = Math.round(amountMyr * exchange.gemsPerMyr);

    const payment = createPayment(userId, { provider: "billplz", amountMyr, gems });
    const bill = await createBill(payment.id, amountMyr, gems, userId);
    await updatePayment(payment.id, { providerRef: bill.id });
    return { billUrl: bill.url, paymentId: payment.id, gems };
  }

  if (method === "manual_tng" || method === "manual_bank") {
    if (!amountMyr || amountMyr < config.minTopupMyr) {
      throw new Error(`Minimum top-up is RM ${config.minTopupMyr}`);
    }
    const { paymentId, gems, instructions, qrUrl } = await startManualTopup(userId, {
      provider: method,
      amountMyr,
    });
    return { paymentId, gems, instructions, qrUrl };
  }

  // Package-based topup
  if (packageId) {
    const packages = await listPackages();
    const pkg = packages.find((p) => p.id === packageId);
    if (!pkg) throw new Error("Package not found");
    amountMyr = pkg.priceMyr;
  }

  if (!amountMyr || amountMyr < config.minTopupMyr) {
    throw new Error(`Minimum top-up is RM ${config.minTopupMyr}`);
  }

  const exchange = await getExchangeInfo();
  const gems = Math.round(amountMyr * exchange.gemsPerMyr);

  return { amountMyr, gems, note: "Top-up created" };
}

async function getWalletInfo(userId) {
  const exchange = await getExchangeInfo();
  const balance = await getUserBalance(userId);
  const methods = [];

  if (config.allowManualPayments) {
    methods.push({ id: "manual_tng", name: "Touch n Go (manual)" });
    methods.push({ id: "manual_bank", name: "Bank transfer (manual)" });
  }
  if (config.allowBillplz) {
    methods.push({ id: "billplz", name: "Billplz (FPX / Card / TnG)" });
  }

  return {
    balance,
    exchange,
    methods,
    billplzFee: config.allowBillplz ? 0.035 : 0,
  };
}

async function isAdmin(telegramId) {
  return config.adminTelegramIds.includes(String(telegramId));
}

async function handleBillplzCallback(params) {
  const { billplzCallback } = require("./billplz");
  return billplzCallback(params);
}

async function handleTelegramSuccessfulPayment(userId, paymentData) {
  const providerRef = paymentData.telegram_payment_charge_id;
  const totalAmount = paymentData.total_amount / 100; // Stars amount
  const payload = paymentData.invoice_payload || "{}";
  let parsedPayload = {};
  try { parsedPayload = JSON.parse(payload); } catch {}

  const gems = parsedPayload.gems || Math.round(totalAmount * (config.myrPerStar || 0.052) * 10000);
  const amountMyr = parsedPayload.amountMyr || totalAmount * (config.myrPerStar || 0.052);

  const existing = await getPaymentByProviderRef("telegram_stars", providerRef);
  if (existing && existing.status === "paid") {
    return { payment: existing };
  }

  const payment = existing || await createPayment(userId, {
    provider: "telegram_stars",
    amountMyr,
    gems,
    providerRef,
  });

  if (payment.status !== "paid") {
    await completePayment(payment.id, userId);
  }

  return { payment: { ...payment, status: "paid" } };
}

async function completePayment(paymentId, userId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status === "paid") return payment;

  await updatePayment(paymentId, { status: "paid", paidAt: new Date().toISOString() });
  await creditGems(userId || payment.userId, payment.gems, "topup", paymentId, `Payment #${paymentId}`);

  return { ...payment, status: "paid" };
}

async function adminApprovePayment(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status === "paid") throw new Error("Payment already processed");
  if (payment.status === "cancelled") throw new Error("Payment was cancelled");

  return completePayment(paymentId);
}

async function adminRejectPayment(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status !== "pending" && payment.status !== "pending_review") {
    throw new Error("Cannot reject payment in status: " + payment.status);
  }

  await updatePayment(paymentId, { status: "cancelled" });
  return { ok: true, message: `Payment #${paymentId} rejected` };
}

async function adminRevokePayment(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status !== "paid") throw new Error("Can only revoke paid payments");

  // Debit the credited gems back
  const { debitGems } = require("../gems");
  await debitGems(payment.userId, payment.gems, "revoke", paymentId, `Revoke payment #${paymentId}`);
  await updatePayment(paymentId, { status: "pending" });

  return { ok: true, message: `Payment #${paymentId} revoked — ${payment.gems.toLocaleString()} gems deducted. Status reset to pending.` };
}

module.exports = {
  createTopup,
  getWalletInfo,
  isAdmin,
  completePayment,
  adminApprovePayment,
  adminRejectPayment,
  adminRevokePayment,
  handleBillplzCallback,
  handleTelegramSuccessfulPayment,
  listPendingManualPayments,
  listPackages,
};