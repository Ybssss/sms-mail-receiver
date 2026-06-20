const { config } = require("../../config");

function getManualPaymentInfo(provider) {
  const baseUrl = config.webappUrl || "";
  if (provider === "manual_tng") {
    const qrUrl = baseUrl
      ? `${baseUrl}/qr/qr-tng.jpg`
      : config.manualTngQrUrl || null;
    return {
      id: "manual_tng",
      name: "Touch n Go (manual)",
      title: "Touch n Go eWallet",
      qrUrl: qrUrl,
      details: [
        `📱 TnG: ${config.manualTngPhone}`,
        ...(qrUrl ? ["Scan QR below to pay:"] : []),
      ],
      note: "After payment, wait for admin approval.",
    };
  }

  const qrUrl = baseUrl
    ? `${baseUrl}/qr/qr-bank.jpg`
    : config.manualBankQrUrl || null;
  return {
    id: "manual_bank",
    name: "Bank transfer (manual)",
    title: "Bank transfer",
    qrUrl: qrUrl,
    details: [
      `🏦 Bank: ${config.manualBankName}`,
      `📄 Account: ${config.manualBankAccount}`,
      `👤 Name: ${config.manualBankHolder}`,
      ...(qrUrl ? ["Scan QR below to pay:"] : []),
    ],
    note: "After payment, wait for admin approval.",
  };
}

async function startManualTopup(userId, { provider, amountMyr }) {
  const { createPayment } = require("./store");
  const { fetchUsdMyrRate, myrToGems } = require("../exchangeRate");

  if (provider === "manual_tng" && !config.manualTngPhone) {
    throw new Error("Manual TnG is not configured");
  }
  if (provider === "manual_bank" && !config.manualBankAccount) {
    throw new Error("Manual bank transfer is not configured");
  }

  const usdMyr = await fetchUsdMyrRate();
  const gems = myrToGems(amountMyr, usdMyr);
  const info = getManualPaymentInfo(provider);

  const payment = createPayment(userId, {
    provider,
    amountMyr,
    gems,
    meta: { qrUrl: info.qrUrl, details: info.details },
  });

  const detailLines = [
    `${info.title}:`,
    ...info.details.map((d) => `  ${d}`),
    `  Reference: Payment #${payment.id}`,
    `  Amount: RM ${amountMyr.toFixed(2)}`,
    "",
    info.note,
  ];

  return {
    paymentId: payment.id,
    gems,
    amountMyr,
    provider,
    title: info.title,
    qrUrl: info.qrUrl,
    details: info.details,
    instructions: detailLines,
  };
}

module.exports = {
  startManualTopup,
  getManualPaymentInfo,
};
