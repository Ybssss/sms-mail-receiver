const { config } = require("../../config");
const {
  fetchUsdMyrRate,
  myrToGems,
  getExchangeInfo,
} = require("../exchangeRate");
const { creditGems, getUserBalance, formatGems } = require("../gems");
const {
  createPayment,
  getPaymentById,
  getPaymentByProviderRef,
  updatePayment,
  listPackages,
  listPendingManualPayments,
} = require("./store");
const { startBillplzTopup, verifyBillplzSignature } = require("./billplz");
const { startManualTopup } = require("./manual");
const { buildStarsPayload } = require("./telegramStars");
const { createInvoiceLink } = require("../telegramBot");

async function completePayment(paymentId, providerRef = null) {
  const payment = getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status === "paid") return { alreadyPaid: true, payment };

  updatePayment(paymentId, {
    status: "paid",
    paidAt: new Date().toISOString(),
    providerRef: providerRef || payment.providerRef,
  });

  const balance = creditGems(
    payment.userId,
    payment.gems,
    "topup",
    paymentId,
    `${payment.provider} RM${payment.amountMyr}`,
  );

  return { payment: getPaymentById(paymentId), balance };
}

async function handleBillplzCallback(body) {
  const paid = body.paid === "true" || body.paid === true;
  const paymentId = parseInt(body.reference_1, 10);

  if (body.x_signature && !verifyBillplzSignature(body, body.x_signature)) {
    throw new Error("Invalid Billplz signature");
  }

  if (!paid || !paymentId) return { ok: false, reason: "not_paid" };

  const result = await completePayment(paymentId, body.id);
  return { ok: true, ...result };
}

async function handleTelegramSuccessfulPayment(userId, telegramPayment) {
  const providerRef = telegramPayment.telegram_payment_charge_id;
  const existing = getPaymentByProviderRef("telegram_stars", providerRef);
  if (existing?.status === "paid")
    return { alreadyPaid: true, payment: existing };

  const payload = JSON.parse(telegramPayment.invoice_payload || "{}");
  const gems =
    payload.gems ||
    (await require("./telegramStars").gemsForStars(
      telegramPayment.total_amount,
    ));

  if (payload.paymentId) {
    const pending = getPaymentById(payload.paymentId);
    if (pending?.status === "paid")
      return { alreadyPaid: true, payment: pending };
    if (pending && pending.userId === userId) {
      return completePayment(payload.paymentId, providerRef);
    }
  }

  let payment = existing;
  if (!payment) {
    const usdMyr = await fetchUsdMyrRate();
    const amountMyr = telegramPayment.total_amount * config.myrPerStar;
    payment = createPayment(userId, {
      provider: "telegram_stars",
      amountMyr,
      gems,
      providerRef,
      meta: { stars: telegramPayment.total_amount },
    });
  }

  return completePayment(payment.id, providerRef);
}

async function createTopup(userId, { method, packageId, amountMyr, token }) {
  const packages = await listPackages();
  let gems;
  let myr;

  if (packageId) {
    const pkg = packages.find((p) => p.id === packageId);
    if (!pkg) throw new Error("Package not found");
    gems = pkg.gems;
    myr = pkg.priceMyr;
  } else if (amountMyr) {
    myr = parseFloat(amountMyr);
    if (!myr || myr < config.minTopupMyr) {
      throw new Error(`Minimum top-up is RM ${config.minTopupMyr}`);
    }
    const usdMyr = await fetchUsdMyrRate();
    gems = myrToGems(myr, usdMyr);
  } else {
    throw new Error("Specify packageId or amountMyr");
  }

  switch (method) {
    case "billplz":
      return startBillplzTopup(userId, {
        amountMyr: myr,
        gems,
        description: `${gems.toLocaleString()} gems top-up`,
      });
    case "manual_tng":
    case "manual_bank":
      return startManualTopup(userId, { provider: method, amountMyr: myr });
    case "telegram_stars":
      return startStarsTopup(userId, { amountMyr: myr, gems, packageId });
    default:
      throw new Error(`Unknown payment method: ${method}`);
  }
}

async function startStarsTopup(userId, { amountMyr, gems, packageId = null }) {
  const payment = createPayment(userId, {
    provider: "telegram_stars",
    amountMyr,
    gems,
    meta: { packageId },
  });

  const stars = Math.max(1, Math.ceil(amountMyr / config.myrPerStar));
  const title = `${gems.toLocaleString()} gems`;
  const payload = JSON.stringify({
    userId,
    packageId,
    gems,
    paymentId: payment.id,
  });

  const invoice = buildStarsPayload({
    title,
    description: `${gems.toLocaleString()} gems for Hero-SMS email orders`,
    starCount: stars,
    payload,
  });

  let invoiceLink = null;
  try {
    invoiceLink = await createInvoiceLink(invoice);
  } catch {
    // Bot may not be registered yet during tests; invoice still works in chat via replyWithInvoice.
  }

  return {
    method: "telegram_stars",
    paymentId: payment.id,
    gems,
    amountMyr,
    stars,
    invoice,
    invoiceLink,
  };
}

async function getWalletInfo(userId) {
  const exchange = await getExchangeInfo();
  const packages = await listPackages();
  return {
    balance: getUserBalance(userId),
    balanceFormatted: formatGems(getUserBalance(userId)),
    exchange,
    packages,
    methods: getAvailableMethods(),
    billplzFee: config.allowBillplz ? 0.035 : 0,
    manual: {
      tngPhone: config.allowManualPayments
        ? config.manualTngPhone || null
        : null,
      bankName: config.allowManualPayments
        ? config.manualBankName || null
        : null,
      bankAccount: config.allowManualPayments
        ? config.manualBankAccount || null
        : null,
      bankHolder: config.allowManualPayments
        ? config.manualBankHolder || null
        : null,
    },
    minTopupMyr: config.minTopupMyr,
    paymentPolicy: {
      automatedOnly: !config.allowManualPayments,
      creditCardAllowed: config.allowCreditCard,
    },
  };
}

function getAvailableMethods() {
  const methods = [];

  if (config.telegramPaymentProviderToken) {
    methods.push({
      id: "telegram_stars",
      name: "Telegram Stars (instant)",
      type: "telegram",
      automated: true,
    });
  }

  if (
    config.allowBillplz &&
    config.billplzApiKey &&
    config.billplzCollectionId
  ) {
    const label = config.allowCreditCard
      ? "FPX / Card / TnG / GrabPay"
      : "FPX / TnG / GrabPay (no card)";
    methods.push({
      id: "billplz",
      name: label,
      type: "redirect",
      automated: true,
    });
  }

  if (config.allowManualPayments && config.manualTngPhone) {
    methods.push({
      id: "manual_tng",
      name: "Touch n Go (manual)",
      type: "manual",
      automated: false,
    });
  }

  if (config.allowManualPayments && config.manualBankAccount) {
    methods.push({
      id: "manual_bank",
      name: "Bank transfer (manual)",
      type: "manual",
      automated: false,
    });
  }

  return methods;
}

function isAdmin(telegramId) {
  if (!config.adminTelegramIds.length) return false;
  return config.adminTelegramIds.includes(String(telegramId));
}

async function adminApprovePayment(paymentId) {
  return completePayment(paymentId);
}

async function adminRejectPayment(paymentId) {
  const { getPaymentById, updatePayment } = require("./store");
  const payment = getPaymentById(paymentId);
  if (!payment) throw new Error("Payment not found");
  if (payment.status === "paid") throw new Error("Payment already approved");
  updatePayment(paymentId, {
    status: "rejected",
    meta: { ...payment.meta, rejectedAt: new Date().toISOString() },
  });
  return { ok: true, paymentId };
}

module.exports = {
  completePayment,
  handleBillplzCallback,
  handleTelegramSuccessfulPayment,
  createTopup,
  startStarsTopup,
  getWalletInfo,
  getAvailableMethods,
  isAdmin,
  adminApprovePayment,
  adminRejectPayment,
  listPendingManualPayments,
};
