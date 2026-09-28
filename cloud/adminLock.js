// The Admin area (settings, branding, payment keys, access rules, audit log,
// errors, data & privacy) opens only after the owner enters their PIN again.
// The unlock belongs to the signed-in session and lasts 15 minutes from the
// last use, so a phone or computer left signed in does not leave the payment
// keys or customer data open. Enforced here on the server, not just hidden
// in the app.

const crypto = require('crypto');
const { MASTER, adminOnly, audit, forbidden, verifyPin } = require('./lib/core');

const UNLOCK_MINUTES = 15;
const LOCKED = 'Admin is locked. Enter your PIN to open it.';

const sessionToken = (request) =>
  request.user?.getSessionToken?.() || request.headers?.['x-parse-session-token'] || '';
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function unlockRow(request) {
  const token = sessionToken(request);
  if (!token) return null;
  const query = new Parse.Query('AdminUnlock');
  query.equalTo('tokenHash', hash(token));
  return query.first(MASTER);
}

// For every Admin-area function: the owner, with Admin unlocked on this
// session. Each use keeps it open for another 15 minutes. The master key
// (dashboard, tests) passes. Returns the owner.
async function requireAdminUnlock(request) {
  if (request.master) return null;
  const actor = await adminOnly(request);
  const row = await unlockRow(request);
  const now = Date.now();
  if (!row || row.get('user')?.id !== actor.id || row.get('expiresAt') <= new Date(now))
    throw forbidden(LOCKED);
  // Extend at most once a minute, not on every call.
  if (row.get('expiresAt') - now < (UNLOCK_MINUTES - 1) * 60000) {
    row.set('expiresAt', new Date(now + UNLOCK_MINUTES * 60000));
    await row.save(null, MASTER);
  }
  return actor;
}

// { pin } → opens Admin on this session. Wrong PINs count towards the same
// lockout as the other PIN steps.
Parse.Cloud.define('unlockAdmin', async (request) => {
  const actor = await adminOnly(request);
  const token = sessionToken(request);
  if (!token) throw forbidden('Sign in again to open Admin');
  await verifyPin(actor, request.params?.pin);
  const row = (await unlockRow(request)) || new Parse.Object('AdminUnlock');
  const until = new Date(Date.now() + UNLOCK_MINUTES * 60000);
  row.set({ tokenHash: hash(token), user: actor, expiresAt: until });
  row.setACL(new Parse.ACL());
  await row.save(null, MASTER);
  // Old unlocks (other sessions, expired) are cleared as new ones are made.
  const stale = new Parse.Query('AdminUnlock');
  stale.lessThan('expiresAt', new Date());
  const expired = await stale.find(MASTER);
  if (expired.length) await Parse.Object.destroyAll(expired, MASTER);
  await audit(actor, 'admin.unlocked', { className: 'Admin', id: 'unlock' }, null, {
    minutes: UNLOCK_MINUTES,
  });
  return { unlocked: true, until: until.toISOString(), minutes: UNLOCK_MINUTES };
});

// Whether Admin is open on this session, and until when.
Parse.Cloud.define('getAdminUnlock', async (request) => {
  const actor = await adminOnly(request);
  const row = await unlockRow(request);
  const open = !!row && row.get('user')?.id === actor.id && row.get('expiresAt') > new Date();
  return {
    unlocked: open,
    until: open ? row.get('expiresAt').toISOString() : null,
    minutes: UNLOCK_MINUTES,
  };
});

// Close Admin now (the "Lock" button, and on sign-out).
Parse.Cloud.define('lockAdmin', async (request) => {
  await adminOnly(request);
  const row = await unlockRow(request);
  if (row) await row.destroy(MASTER);
  return { unlocked: false };
});

module.exports = { requireAdminUnlock, LOCKED, UNLOCK_MINUTES };
