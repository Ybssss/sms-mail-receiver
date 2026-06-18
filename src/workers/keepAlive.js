const { config } = require('../config');

let timer = null;
let lastPingAt = null;
let lastPingOk = true;

async function pingSelf() {
  const baseUrl = config.webappUrl || `http://127.0.0.1:${config.port}`;
  const url = `${baseUrl}/api/health?keepalive=1`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'render-keepalive/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    lastPingOk = response.ok;
    lastPingAt = new Date().toISOString();

    if (!response.ok) {
      console.warn(`Keep-alive ping failed: HTTP ${response.status}`);
    }
  } catch (err) {
    lastPingOk = false;
    lastPingAt = new Date().toISOString();
    console.warn(`Keep-alive ping error: ${err.message}`);
  }
}

function startKeepAlive() {
  if (timer) return;

  pingSelf();
  timer = setInterval(pingSelf, config.keepAliveIntervalMs);
  console.log(`Render keep-alive started (every ${config.keepAliveIntervalMs}ms → /api/health)`);
}

function stopKeepAlive() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getKeepAliveStatus() {
  return {
    enabled: Boolean(timer),
    intervalMs: config.keepAliveIntervalMs,
    lastPingAt,
    lastPingOk,
    target: config.webappUrl ? `${config.webappUrl}/api/health` : `http://127.0.0.1:${config.port}/api/health`,
  };
}

module.exports = { startKeepAlive, stopKeepAlive, getKeepAliveStatus, pingSelf };
