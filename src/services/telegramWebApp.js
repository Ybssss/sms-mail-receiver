const crypto = require('crypto');
const { config } = require('../config');

function validateInitData(initData) {
  if (!initData || !config.botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const maxAgeSec = 86400;
  if (authDate && Date.now() / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user?.id) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}

module.exports = { validateInitData };
