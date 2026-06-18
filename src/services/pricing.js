const { config } = require('../config');
const { fetchUsdMyrRate, gemsPerMyr, myrToGems } = require('./exchangeRate');

async function heroCostToMyr(cost, currency) {
  if (cost == null || cost <= 0) return config.defaultOrderCostMyr;

  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'MYR' || cur === 'RM') return cost;
  if (cur === 'USD') {
    const usdMyr = await fetchUsdMyrRate();
    return cost * usdMyr;
  }
  return cost * config.defaultOrderCostMyr;
}

async function calculateOrderCostGems(domainCost, domainCurrency) {
  const usdMyr = await fetchUsdMyrRate();
  const costMyr = await heroCostToMyr(domainCost, domainCurrency);
  const withMarkup = costMyr * (1 + config.orderMarkupPercent / 100);
  const gems = myrToGems(withMarkup, usdMyr);
  return Math.max(gems, config.minOrderGems);
}

async function getDomainOrderCostGems(domains, domainName) {
  const domain = (Array.isArray(domains) ? domains : []).find(
    (d) => d.name === domainName || d.domain === domainName
  );
  const cost = domain?.cost ?? null;
  const currency = domain?.currency ?? 'USD';
  return calculateOrderCostGems(cost, currency);
}

module.exports = {
  heroCostToMyr,
  calculateOrderCostGems,
  getDomainOrderCostGems,
};
