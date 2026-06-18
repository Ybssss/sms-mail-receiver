const path = require('path');
const express = require('express');
const { config } = require('../config');
const { webhookUrl } = require('../bot/telegram');
const { getDomains, orderEmail, cancelEmail, getEmail } = require('../services/heroSms');
const {
  findUserByToken,
  getOrCreateWebUser,
  saveOrder,
  listOrders,
  getOrderById,
} = require('../services/mailStore');
const { handleWebhookPayload } = require('../services/pollWorker');
const { getKeepAliveStatus } = require('../workers/keepAlive');

function createWebApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      keepAlive: getKeepAliveStatus(),
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      botUsername: config.botUsername || null,
      defaultSite: config.defaultSite,
      defaultDomain: config.defaultDomain,
      webhookUrl: webhookUrl(),
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  app.post('/webhook/hero-sms', async (req, res) => {
    if (config.webhookSecret) {
      const secret = req.headers['x-webhook-secret'] || req.query.secret;
      if (secret !== config.webhookSecret) {
        res.status(401).json({ ok: false, error: 'invalid_secret' });
        return;
      }
    }

    try {
      const result = await handleWebhookPayload(req.body);
      res.json(result);
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/session', (req, res) => {
    const token = req.query.token;
    const user = token ? findUserByToken(token) : null;

    if (user) {
      res.json({ token: user.access_token, source: user.telegram_id ? 'telegram' : 'web' });
      return;
    }

    const newUser = getOrCreateWebUser(null);
    res.json({ token: newUser.access_token, source: 'web' });
  });

  app.use('/api', (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;

    if (!token) {
      res.status(401).json({ error: 'Missing access token' });
      return;
    }

    const user = findUserByToken(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid access token' });
      return;
    }

    req.user = user;
    next();
  });

  app.get('/api/domains', async (_req, res) => {
    try {
      const domains = await getDomains();
      res.json({ domains: Array.isArray(domains) ? domains : [] });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/orders', (req, res) => {
    res.json({ orders: listOrders(req.user.id, { limit: 100 }) });
  });

  app.get('/api/orders/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const order = getOrderById(id, req.user.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    try {
      const remote = await getEmail(order.heroId);
      const updated = saveOrder(req.user.id, remote);
      res.json({ order: updated });
    } catch {
      res.json({ order });
    }
  });

  app.post('/api/orders', async (req, res) => {
    try {
      const site = (req.body?.site || config.defaultSite).trim();
      const domain = (req.body?.domain || config.defaultDomain).trim();
      const remote = await orderEmail(site, domain);
      const saved = saveOrder(req.user.id, remote);
      res.status(201).json({ order: saved });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const order = getOrderById(id, req.user.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    try {
      await cancelEmail(order.heroId);
      saveOrder(req.user.id, { ...order, heroId: order.heroId, status: 'CANCELLED' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

module.exports = { createWebApp };
