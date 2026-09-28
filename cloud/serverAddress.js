// The public IP address this server uses when it calls out (to MTN MoMo and
// Airtel Money). Airtel asks for it on its "Server IP Allowed List". Hosts
// such as Back4App's shared plans may change it, so every check is compared
// with the last one: a change is shown in Admin → Payments and, from the
// nightly cash check, sent to the owner as a notification.

const net = require('net');
const { MASTER } = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');
const { log, errorMessage } = require('./lib/log');

const SECRET_KEY = 'serverAddress';
// Plain "what is my IP" services; the first that answers wins. Tests point
// RELAY_IP_URL at a stand-in.
const LOOKUPS = () =>
  process.env.RELAY_IP_URL
    ? [process.env.RELAY_IP_URL]
    : ['https://api.ipify.org', 'https://checkip.amazonaws.com', 'https://ifconfig.me/ip'];

async function lookUp() {
  for (const url of LOOKUPS()) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(8000),
      });
      const ip = (await response.text()).trim();
      if (response.ok && net.isIP(ip)) return ip;
    } catch (error) {
      log('warn', 'server_address.lookup_failed', { url, message: errorMessage(error) });
    }
  }
  return '';
}

async function row() {
  const query = new Parse.Query('Secret');
  query.equalTo('key', SECRET_KEY);
  query.ascending('createdAt');
  return (
    (await query.first(MASTER)) ||
    (() => {
      const created = new Parse.Object('Secret');
      created.set({ key: SECRET_KEY, value: {} });
      created.setACL(new Parse.ACL());
      return created;
    })()
  );
}

// Looks the address up now and records it. Returns
// { ip, previous, changedAt, checkedAt, changed, history: [{ ip, firstSeen, lastSeen }] }.
async function checkServerAddress() {
  const ip = await lookUp();
  const record = await row();
  const value = record.get('value') || {};
  const now = new Date().toISOString();
  const history = Array.isArray(value.history) ? value.history : [];
  let changed = false;
  if (ip) {
    const last = history[0];
    if (last && last.ip === ip) last.lastSeen = now;
    else {
      changed = !!last;
      history.unshift({ ip, firstSeen: now, lastSeen: now });
    }
    record.set('value', {
      history: history.slice(0, 10),
      ...(changed ? { changedAt: now } : value.changedAt ? { changedAt: value.changedAt } : {}),
      checkedAt: now,
    });
    await record.save(null, MASTER);
  }
  const saved = record.get('value') || {};
  return {
    ip,
    previous: saved.history?.[1]?.ip || '',
    changedAt: saved.changedAt || null,
    checkedAt: saved.checkedAt || now,
    changed,
    history: saved.history || [],
  };
}

// Owner (Admin → Payments): the address to give Airtel, and whether it has
// changed before.
Parse.Cloud.define('adminGetServerAddress', async (request) => {
  await requireAdminUnlock(request);
  return checkServerAddress();
});

// Nightly (cashCheck job): tell the owner when the address has changed, so
// Airtel's allowed list can be updated before payment requests start failing.
async function watchServerAddress() {
  const result = await checkServerAddress();
  if (result.changed) {
    const { notifyAdmins } = require('./notifications');
    await notifyAdmins({
      kind: 'server.address_changed',
      tone: 'alert',
      title: 'The server’s address changed',
      body: `Now ${result.ip} (was ${result.previous}). Add it to Airtel’s Server IP Allowed List.`,
      link: '/admin/site/payments',
    });
  }
  return result;
}

module.exports = { checkServerAddress, watchServerAddress };
