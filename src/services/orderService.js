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
 * Falls back to using the domain name itself as site if not found.
 */
async function resolveOrderDomain(domainName, siteHint) {
  const domains = await getDomains();
  const list = Array.isArray(domains) ? domains : [];

  console.log("[DEBUG] resolveOrderDomain input:", { domainName, siteHint });
  console.log("[DEBUG] domain list count:", list.length);

  // Try to find the exact match by name or domain field
  const match = list.find(
    (d) => (d.name || d.domain) === domainName || d.domain === domainName,
  );

  if (match) {
    console.log("[DEBUG] Found match:", JSON.stringify(match));
    // Hero-SMS may return domain objects with fields: name, domain, site, cost, count, currency
    // Prioritize: site → name → domain as the 'site' value for ordering
    const site = (match.site || match.name || match.domain || "").trim();
    const domain = (match.domain || match.name || "").trim();
    console.log("[DEBUG] Resolved:", { site, domain });
    if (site && domain) return { site, domain };
  }

  // Fallback: if no match found, use what we have
  const site = (siteHint || domainName || "").trim();
  const domain = (domainName || "").trim();
  console.log("[DEBUG] Fallback resolve:", { site, domain });
  if (!site) {
    throw new Error(
      "Could not determine site for domain: " +
        domainName +
        ". Ensure domain exists in Hero-SMS.",
    );
  }
  if (!domain) {
    throw new Error("Could not determine domain name");
  }
  return { site, domain };
}

module.exports = {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
  resolveOrderDomain,
};
