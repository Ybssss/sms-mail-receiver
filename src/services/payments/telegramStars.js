const { config } = require('../../config');
const { fetchUsdMyrRate, myrToGems } = require('../exchangeRate');

async function gemsForStars(starCount) {
  const usdMyr = await fetchUsdMyrRate();
  const myrValue = starCount * config.myrPerStar;
  return myrToGems(myrValue, usdMyr);
}

async function starsForGems(gems) {
  const usdMyr = await fetchUsdMyrRate();
  const gemsPerMyr = require('../exchangeRate').gemsPerMyr(usdMyr);
  const myr = gems / gemsPerMyr;
  return Math.max(1, Math.ceil(myr / config.myrPerStar));
}

function buildStarsPayload({ title, description, starCount, payload }) {
  if (!config.telegramPaymentProviderToken) {
    throw new Error('Telegram Stars not configured (TELEGRAM_PAYMENT_PROVIDER_TOKEN)');
  }

  return {
    title,
    description,
    payload,
    provider_token: config.telegramPaymentProviderToken,
    currency: 'XTR',
    prices: [{ label: title, amount: starCount }],
  };
}

module.exports = {
  gemsForStars,
  starsForGems,
  buildStarsPayload,
};
