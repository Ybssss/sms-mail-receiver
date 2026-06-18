const { config } = require('../../config');
const { fetchUsdMyrRate, myrToGems, getExchangeInfo } = require('../exchangeRate');
const { creditGems, getUserBalance, formatGems } = require('../gems');
const {
  createPayment,
  getPaymentById,
  getPaymentByProviderRef,
  updatePayment,
  listPackages,
  listPendingManualPayments,
} = require('./store');
const { startBillplzTopup, verifyBillplzSignature } = require('./billplz');
const { startManualTopup } = require('./manual');
const { gemsForStars } = require('./telegramStars');

async function completePayment(paymentId, providerRef = null) {
  const payment = getPaymentById(paymentId);
  if (!payment) throw new Error('Payment not found');
  if (payment.status === 'paid') return { alreadyPaid: true, payment };

  updatePayment(paymentId, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    providerRef: providerRef || payment.providerRef,
  });

  const balance = creditGems(
    payment.userId,
    payment.gems,
    'topup',
    paymentId,
    `${payment.provider} RM${payment.amountMyr}`
  );

  return { payment: getPaymentById(paymentId), balance };
}

async function handleBillplzCallback(body) {
  const paid = body.paid === 'true' || body.paid === true;
  const paymentId = parseInt(body.reference_1, 10);

  if (body.x_signature && !verifyBillplzSignature(body, body.x_signature)) {
    throw new Error('Invalid Billplz signature');
  }

  if (!paid || !paymentId) return { ok: false, reason: 'not_paid' };

  const result = await completePayment(paymentId, body.id);
  return { ok: true, ...result };
}

async function handleTelegramSuccessfulPayment(userId, telegramPayment) {
  const providerRef = telegramPayment.telegram_payment_charge_id;
  const existing = getPaymentByProviderRef('telegram_stars', providerRef);
  if (existing?.status === 'paid') return { alreadyPaid: true, payment: existing };

  const payload = JSON.parse(telegramPayment.invoice_payload || '{}');
  const gems = payload.gems || (await gemsForStars(telegramPayment.total_amount));

  let payment = existing;
  if (!payment) {
    const usdMyr = await fetchUsdMyrRate();
    const amountMyr = (telegramPayment.total_amount * config.myrPerStar);
    payment = createPayment(userId, {
      provider: 'telegram_stars',
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
    if (!pkg) throw new Error('Package not found');
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
    throw new Error('Specify packageId or amountMyr');
  }

  switch (method) {
    case 'billplz':
      return startBillplzTopup(userId, {
        amountMyr: myr,
        gems,
        description: `${gems.toLocaleString()} gems top-up`,
      });
    case 'manual_tng':
    case 'manual_bank':
      return startManualTopup(userId, { provider: method, amountMyr: myr });
    case 'telegram_stars':
      return {
        method: 'telegram_stars',
        gems,
        amountMyr: myr,
        stars: Math.max(1, Math.ceil(myr / config.myrPerStar)),
        note: 'Use /topup in Telegram bot to pay with Stars',
      };
    default:
      throw new Error(`Unknown payment method: ${method}`);
  }
}

async function getWalletInfo(userId) {
  const exchange = await getExchangeInfo();
  const packages = await listPackages();
  return {
    balance: getUserBalance(userId),
    balanceFormatted: formatGems(getUserBalance(userId)),
    exchange,
    packages: listPackages(),
    methods: getAvailableMethods(),
    manual: {
      tngPhone: config.manualTngPhone || null,
      bankName: config.manualBankName || null,
      bankAccount: config.manualBankAccount || null,
      bankHolder: config.manualBankHolder || null,
    },
    minTopupMyr: config.minTopupMyr,
  };
}

function getAvailableMethods() {
  const methods = [];
  if (config.billplzApiKey && config.billplzCollectionId) {
    methods.push({ id: 'billplz', name: 'FPX / Card / TnG / GrabPay', type: 'redirect' });
  }
  if (config.telegramPaymentProviderToken) {
    methods.push({ id: 'telegram_stars', name: 'Telegram Stars', type: 'telegram' });
  }
  if (config.manualTngPhone) {
    methods.push({ id: 'manual_tng', name: 'Touch n Go (manual)', type: 'manual' });
  }
  if (config.manualBankAccount) {
    methods.push({ id: 'manual_bank', name: 'Bank transfer (manual)', type: 'manual' });
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

module.exports = {
  completePayment,
  handleBillplzCallback,
  handleTelegramSuccessfulPayment,
  createTopup,
  getWalletInfo,
  getAvailableMethods,
  isAdmin,
  adminApprovePayment,
  listPendingManualPayments,
};
