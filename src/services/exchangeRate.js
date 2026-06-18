const { config } = require('../config');

let cache = {
  usdMyr: null,
  fetchedAt: 0,
};

async function fetchUsdMyrRate() {
  const now = Date.now();
  if (cache.usdMyr && now - cache.fetchedAt < config.exchangeRateCacheMs) {
    return cache.usdMyr;
  }

  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=USD&to=MYR');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const rate = data?.rates?.MYR;
    if (!rate || rate <= 0) throw new Error('Invalid MYR rate');
    cache = { usdMyr: rate, fetchedAt: now };
    return rate;
  } catch (err) {
    console.warn('Exchange rate fetch failed, using fallback:', err.message);
    if (cache.usdMyr) return cache.usdMyr;
    return config.baseUsdMyr;
  }
}

function gemsPerMyr(usdMyr) {
  const base = config.baseUsdMyr;
  const baseGems = config.baseGemsPerMyr;
  if (!usdMyr || usdMyr <= 0) return baseGems;
  return Math.round(baseGems * (base / usdMyr));
}

function myrToGems(myr, usdMyr) {
  return Math.round(myr * gemsPerMyr(usdMyr));
}

function gemsToMyr(gems, usdMyr) {
  const rate = gemsPerMyr(usdMyr);
  if (rate <= 0) return 0;
  return gems / rate;
}

async function getExchangeInfo() {
  const usdMyr = await fetchUsdMyrRate();
  return {
    usdMyr,
    baseUsdMyr: config.baseUsdMyr,
    baseGemsPerMyr: config.baseGemsPerMyr,
    gemsPerMyr: gemsPerMyr(usdMyr),
    formula: `gemsPerMyr = ${config.baseGemsPerMyr} × (${config.baseUsdMyr} / USD/MYR)`,
  };
}

module.exports = {
  fetchUsdMyrRate,
  gemsPerMyr,
  myrToGems,
  gemsToMyr,
  getExchangeInfo,
};
