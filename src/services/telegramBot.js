let botInstance = null;

function setTelegramBot(bot) {
  botInstance = bot;
}

function getTelegramBot() {
  return botInstance;
}

async function createInvoiceLink(invoice) {
  if (!botInstance) throw new Error('Telegram bot is not ready');
  return botInstance.telegram.callApi('createInvoiceLink', invoice);
}

module.exports = {
  setTelegramBot,
  getTelegramBot,
  createInvoiceLink,
};
