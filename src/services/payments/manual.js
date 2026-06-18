const { config } = require('../../config');
const { createPayment } = require('./store');
const { fetchUsdMyrRate, myrToGems } = require('../exchangeRate');

function getManualInstructions(provider) {
  if (provider === 'manual_tng') {
    return {
      title: 'Touch n Go eWallet',
      lines: [
        `Send RM {amount} to TnG: ${config.manualTngPhone}`,
        'Reference: Payment #{id}',
        'Then wait for admin approval (usually within 1 hour).',
      ],
    };
  }

  return {
    title: 'Bank transfer',
    lines: [
      `Bank: ${config.manualBankName}`,
      `Account: ${config.manualBankAccount}`,
      `Name: ${config.manualBankHolder}`,
      'Reference: Payment #{id}',
      'Then wait for admin approval (usually within 1 hour).',
    ],
  };
}

async function startManualTopup(userId, { provider, amountMyr }) {
  if (provider === 'manual_tng' && !config.manualTngPhone) {
    throw new Error('Manual TnG is not configured');
  }
  if (provider === 'manual_bank' && !config.manualBankAccount) {
    throw new Error('Manual bank transfer is not configured');
  }

  const usdMyr = await fetchUsdMyrRate();
  const gems = myrToGems(amountMyr, usdMyr);
  const payment = createPayment(userId, {
    provider,
    amountMyr,
    gems,
    meta: { instructions: getManualInstructions(provider) },
  });

  const instructions = getManualInstructions(provider);
  const detailLines = instructions.lines.map((line) =>
    line
      .replace('{amount}', amountMyr.toFixed(2))
      .replace('{id}', String(payment.id))
  );

  return {
    paymentId: payment.id,
    gems,
    amountMyr,
    provider,
    title: instructions.title,
    instructions: detailLines,
  };
}

module.exports = {
  startManualTopup,
  getManualInstructions,
};
