const { orderEmail, cancelEmail, getDomains } = require("./heroSms");
const { saveOrder } = require("./mailStore");
const { getUserBalance, debitGems, creditGems } = require("./gems");
const { getDomainOrderCostGems } = require("./pricing");

async function placeOrder(userId, site, domain) {
  const domains = await getDomains();
  const costGems = await getDomainOrderCostGems(domains, domain);
  const balance = getUserBalance(userId);

  if (balance < costGems) {
    const err = new Error(
      `Insufficient gems: need ${costGems.toLocaleString()}, have ${balance.toLocaleString()}`,
    );
    err.code = "INSUFFICIENT_GEMS";
    err.requiredGems = costGems;
    err.balance = balance;
    throw err;
  }

  debitGems(userId, costGems, "order", null, `${site} @ ${domain}`);

  try {
    const remote = await orderEmail(site, domain);
    const saved = saveOrder(userId, remote, { gemsCharged: costGems });
    return { order: saved, gemsCharged: costGems };
  } catch (err) {
    creditGems(
      userId,
      costGems,
      "refund",
      null,
      `Order failed: ${err.message}`,
    );
    throw err;
  }
}

async function cancelOrderWithRefund(userId, order) {
  await cancelEmail(order.heroId);

  if (order.gemsCharged && order.gemsCharged > 0 && !order.value) {
    creditGems(
      userId,
      order.gemsCharged,
      "refund",
      order.id,
      `Cancel order #${order.id}`,
    );
  }

  saveOrder(userId, { ...order, heroId: order.heroId, status: "CANCELLED" });
}

async function estimateOrderCost(domain) {
  const domains = await getDomains();
  const costGems = await getDomainOrderCostGems(domains, domain);
  return { domain, costGems };
}

/**
 * Resolve a domain name to its proper site + domain fields.
 * Looks up the Hero-SMS domain list to find the matching entry.
 * Falls back to defaults if domain is not found.
 */
async function resolveOrderDomain(domainName, siteHint) {
  const domains = await getDomains();
  const list = Array.isArray(domains) ? domains : [];

  // Try to find the exact match by name or domain field
  const match = list.find(
    (d) => (d.name || d.domain) === domainName || d.domain === domainName,
  );

  if (match) {
    const site = (match.site || match.name || "").trim();
    const domain = (match.domain || match.name || "").trim();
    if (site && domain) return { site, domain };
  }

  // Fallback: ensure we have non-empty values
  const site = (siteHint || domainName || "").trim();
  const domain = (domainName || siteHint || "").trim();
  if (!site)
    throw new Error("Could not determine site for domain: " + domainName);
  if (!domain) throw new Error("Could not determine domain name");
  return { site, domain };
}

module.exports = {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
  resolveOrderDomain,
};
