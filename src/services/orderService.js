const { placeEmailOrder } = require("./heroSms");
const { getUserBalance, debitGems } = require("./gems");
const { getExchangeInfo, fetchUsdMyrRate, myrToGems, gemsPerMyr } = require("./exchangeRate");
const { getDb } = require("../db/database");
const { config } = require("../config");

async function resolveOrderDomain(domain, site) {
  // Return the resolved site and domain for email activation
  return {
    site: site || domain || config.defaultSite,
    domain: domain || config.defaultDomain,
  };
}

async function estimateOrderCost(serviceName) {
  // Estimate gem cost for a service
  const exchange = await getExchangeInfo();
  const usdMyr = await fetchUsdMyrRate();
  const gemsPerMyrVal = gemsPerMyr(usdMyr);
  const costMyr = config.defaultOrderCostMyr * (1 + config.orderMarkupPercent / 100);
  const costGems = Math.max(Math.round(costMyr * gemsPerMyrVal), config.minOrderGems);
  return { costGems, costMyr };
}

async function placeOrder(userId, site, domain) {
  const { costGems } = await estimateOrderCost(domain);
  const balance = await getUserBalance(userId);

  if (balance < costGems) {
    const err = new Error(`Insufficient gems: need ${costGems.toLocaleString()}, have ${balance.toLocaleString()}`);
    err.code = "INSUFFICIENT_GEMS";
    err.requiredGems = costGems;
    err.balance = balance;
    throw err;
  }

  // Place the order with Hero-SMS API
  const order = await placeEmailOrder(site, domain);

  // Debit gems
  await debitGems(userId, costGems, "email_order", order.id || order.activationId, `${site} email activation`);

  // Save to database
  const { saveOrder } = require("./mailStore");
  const saved = await saveOrder(userId, order, { gemsCharged: costGems });

  return {
    order: saved,
    gemsCharged: costGems,
  };
}

async function cancelOrderWithRefund(userId, order) {
  const { cancelEmailOrder } = require("./heroSms");
  const { creditGems } = require("./gems");

  try {
    await cancelEmailOrder(order.heroId);
  } catch (e) {
    console.error("Cancel order API error:", e.message);
  }

  if (order.gemsCharged && order.gemsCharged > 0) {
    await creditGems(userId, order.gemsCharged, "refund", order.id || order.heroId, `Refund cancelled order #${order.id}`);
  }

  // Update order status in DB
  const { getDb } = require("../db/database");
  const d = getDb();
  const { ObjectId } = require("mongodb");
  let filter;
  try { filter = { _id: new ObjectId(String(order.id)) }; } catch { filter = { hero_id: order.heroId }; }
  await d.collection("email_orders").updateOne(filter, { $set: { status: "CANCELLED", updated_at: new Date().toISOString() } });
}

module.exports = {
  resolveOrderDomain,
  estimateOrderCost,
  placeOrder,
  cancelOrderWithRefund,
};