const { orderEmail, cancelEmail, getDomains } = require('./heroSms');
const { saveOrder } = require('./mailStore');
const { getUserBalance, debitGems, creditGems } = require('./gems');
const { getDomainOrderCostGems } = require('./pricing');

async function placeOrder(userId, site, domain) {
  const domains = await getDomains();
  const costGems = await getDomainOrderCostGems(domains, domain);
  const balance = getUserBalance(userId);

  if (balance < costGems) {
    const err = new Error(`Insufficient gems: need ${costGems.toLocaleString()}, have ${balance.toLocaleString()}`);
    err.code = 'INSUFFICIENT_GEMS';
    err.requiredGems = costGems;
    err.balance = balance;
    throw err;
  }

  debitGems(userId, costGems, 'order', null, `${site} @ ${domain}`);

  try {
    const remote = await orderEmail(site, domain);
    const saved = saveOrder(userId, remote, { gemsCharged: costGems });
    return { order: saved, gemsCharged: costGems };
  } catch (err) {
    creditGems(userId, costGems, 'refund', null, `Order failed: ${err.message}`);
    throw err;
  }
}

async function cancelOrderWithRefund(userId, order) {
  await cancelEmail(order.heroId);

  if (order.gemsCharged && order.gemsCharged > 0 && !order.value) {
    creditGems(userId, order.gemsCharged, 'refund', order.id, `Cancel order #${order.id}`);
  }

  saveOrder(userId, { ...order, heroId: order.heroId, status: 'CANCELLED' });
}

async function estimateOrderCost(domain) {
  const domains = await getDomains();
  const costGems = await getDomainOrderCostGems(domains, domain);
  return { domain, costGems };
}

module.exports = {
  placeOrder,
  cancelOrderWithRefund,
  estimateOrderCost,
};
