// Error reporting. Crashes in the app (sent by src/lib/errors.ts) and
// unexpected failures in Cloud functions and jobs are stored in ErrorLog,
// grouped by where and what went wrong, so the owner sees them under
// Admin → Errors. Expected errors (wrong PIN, missing field, no permission)
// are not recorded. Every entry is also written to the log as JSON.
//
// This file is loaded first (cloud/main.js) so it can wrap every
// Parse.Cloud.define and Parse.Cloud.job registered after it.

const crypto = require('crypto');
const { MASTER, adminOnly, audit, findAll, getRoleName, invalid, readAcl } = require('./lib/core');
const { log, errorMessage, isUnexpected } = require('./lib/log');
const tenancy = require('./lib/tenant');

// Relay Hosted: restaurants are kept apart from here on (lib/tenant.js).
tenancy.install(Parse);

const clip = (value, max) =>
  String(value ?? '')
    .replace(/\s+$/g, '')
    .slice(0, max);

// Ids, numbers and URLs vary between occurrences of the same bug; leave them
// out of the grouping key.
const fingerprintOf = (source, where, message) =>
  crypto
    .createHash('sha1')
    .update(
      [
        source,
        where,
        message.replace(/https?:\/\/\S+/g, '').replace(/[0-9a-f]{8,}|\d+/gi, '#'),
      ].join('|'),
    )
    .digest('hex');

// Stores one occurrence. An open entry with the same fingerprint is counted
// up instead of adding a row, so a crash loop is one line with a big count.
async function recordError({ source, where, message, stack, user, userAgent, url, appVersion }) {
  const text = clip(message, 500) || 'Unknown error';
  const place = clip(where, 200);
  const fingerprint = fingerprintOf(source, place, text);
  const query = new Parse.Query('ErrorLog');
  query.equalTo('fingerprint', fingerprint);
  query.notEqualTo('resolved', true);
  const existing = await query.first(MASTER);
  const role = user ? await getRoleName(user).catch(() => null) : null;
  const seen = {
    lastSeenAt: new Date(),
    stack: clip(stack, 4000),
    userAgent: clip(userAgent, 300),
    url: clip(url, 300),
    appVersion: clip(appVersion, 40),
    role: role || (user ? 'unassigned' : 'signed out'),
    userName: user ? clip(user.get('name') || user.get('username'), 80) : '',
    ...(user && { user }),
  };
  if (existing) {
    existing.increment('count');
    existing.set(seen);
    await existing.save(null, MASTER);
    return existing;
  }
  const row = new Parse.Object('ErrorLog');
  row.set({
    source,
    where: place,
    message: text,
    fingerprint,
    count: 1,
    firstSeenAt: new Date(),
    resolved: false,
    ...seen,
  });
  row.setACL(readAcl(null, []));
  await row.save(null, MASTER);
  return row;
}

// Never lets a failure to record an error hide the original one.
function recordQuietly(entry) {
  return recordError(entry).catch((error) =>
    log('error', 'errorlog.failed', { message: errorMessage(error) }),
  );
}

async function guarded(name, handler, request) {
  const started = Date.now();
  // A sign-in past its days ends here (lib/sessions.js).
  await require('./lib/sessions').checkSession(request);
  try {
    return await handler(request);
  } catch (error) {
    if (isUnexpected(error)) {
      const message = errorMessage(error);
      log('error', 'function.failed', {
        fn: name,
        user: request.user?.id || null,
        ms: Date.now() - started,
        message,
      });
      await recordQuietly({
        source: 'server',
        where: name,
        message,
        stack: error?.stack,
        user: request.user,
      });
    }
    throw error;
  }
}

// Wrap every Cloud function: unexpected failures are logged and recorded,
// then passed on unchanged.
const define = Parse.Cloud.define.bind(Parse.Cloud);
Parse.Cloud.define = (name, handler, validator) =>
  define(
    name,
    async (request) => {
      // Each function runs for the caller's restaurant (lib/tenant.js), so
      // what it records on failure belongs to that restaurant too.
      const restaurant = await tenancy.restaurantFor(request);
      // Relay Hosted: an expired or suspended restaurant can only reach what
      // it needs to sign in and renew (restaurants.js).
      if (restaurant && !request.master)
        await require('./restaurants').checkAccess(name, restaurant);
      return tenancy.runAs(restaurant?.id, () => guarded(name, handler, request), restaurant?.code);
    },
    validator,
  );

const job = Parse.Cloud.job.bind(Parse.Cloud);
Parse.Cloud.job = (name, handler) =>
  job(name, async (request) => {
    const started = Date.now();
    log('info', 'job.started', { job: name });
    try {
      const result = await handler(request);
      log('info', 'job.finished', { job: name, ms: Date.now() - started });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      log('error', 'job.failed', { job: name, ms: Date.now() - started, message });
      await recordQuietly({ source: 'job', where: name, message, stack: error?.stack });
      throw error;
    }
  });

// Crash reports from the app. Anyone may send one (the sign-in screen can
// crash too), limited per person / address so it cannot flood the log.
const REPORT_WINDOW_MS = 10 * 60 * 1000;
const REPORT_LIMIT = 20;
const recent = new Map();
function allowReport(key) {
  const now = Date.now();
  const times = (recent.get(key) || []).filter((time) => now - time < REPORT_WINDOW_MS);
  if (times.length >= REPORT_LIMIT) return false;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

Parse.Cloud.define('reportClientError', async (request) => {
  const p = request.params || {};
  const message = clip(p.message, 500);
  if (!message) throw invalid('Nothing to report');
  const key = request.user?.id || request.ip || 'unknown';
  if (!allowReport(key)) return { recorded: false };
  if (request.user?.get('active') === false) return { recorded: false };
  log('warn', 'app.error', { user: request.user?.id || null, where: clip(p.where, 200), message });
  const row = await recordError({
    source: 'app',
    where: p.where,
    message,
    stack: p.stack,
    user: request.user,
    userAgent: p.userAgent || request.headers?.['user-agent'],
    url: p.url,
    appVersion: p.appVersion,
  });
  return { recorded: true, id: row.id };
});

const OPEN_DAYS = 90;
const FIXED_DAYS = 30;

// Owner: recorded errors, newest first. Old ones are cleared as the list is
// read: fixed ones after 30 days, open ones after 90.
Parse.Cloud.define('adminListErrors', async (request) => {
  // The count in the menu is shown without opening Admin; the list needs it.
  if (request.params?.countOnly) await adminOnly(request);
  else await require('./adminLock').requireAdminUnlock(request);
  const state = request.params?.state === 'fixed' ? 'fixed' : 'open';
  const now = Date.now();
  const stale = await findAll(new Parse.Query('ErrorLog'));
  const expired = stale.filter((row) => {
    const age = (now - (row.get('lastSeenAt') || row.createdAt)) / 86400000;
    return age > (row.get('resolved') ? FIXED_DAYS : OPEN_DAYS);
  });
  if (expired.length) await Parse.Object.destroyAll(expired, MASTER);
  const rows = stale.filter((row) => !expired.includes(row));
  const open = rows.filter((row) => !row.get('resolved'));
  if (request.params?.countOnly) return { open: open.length };
  const shown = (state === 'fixed' ? rows.filter((row) => row.get('resolved')) : open)
    .sort((a, b) => (b.get('lastSeenAt') || 0) - (a.get('lastSeenAt') || 0))
    .slice(0, 200);
  return {
    open: open.length,
    rows: shown.map((row) => ({
      id: row.id,
      source: row.get('source'),
      where: row.get('where') || '',
      message: row.get('message'),
      stack: row.get('stack') || '',
      count: Number(row.get('count') || 1),
      firstSeenAt: row.get('firstSeenAt')?.toISOString() || row.createdAt.toISOString(),
      lastSeenAt: row.get('lastSeenAt')?.toISOString() || row.createdAt.toISOString(),
      role: row.get('role') || '',
      userName: row.get('userName') || '',
      userAgent: row.get('userAgent') || '',
      url: row.get('url') || '',
      appVersion: row.get('appVersion') || '',
      resolved: !!row.get('resolved'),
      resolvedAt: row.get('resolvedAt')?.toISOString() || null,
      // Relay Hosted: marked fixed by Relay for every restaurant it hit.
      resolvedByRelay: !!row.get('resolvedByPlatform'),
    })),
  };
});

// Owner: mark errors fixed. { ids } or { all: true }. If one happens again
// it comes back as a new open entry.
Parse.Cloud.define('adminResolveErrors', async (request) => {
  const actor = await require('./adminLock').requireAdminUnlock(request);
  const p = request.params || {};
  const query = new Parse.Query('ErrorLog');
  query.notEqualTo('resolved', true);
  if (!p.all) {
    const ids = Array.isArray(p.ids) ? p.ids.map(String).slice(0, 500) : [];
    if (!ids.length) throw invalid('Choose the errors to mark as fixed');
    query.containedIn('objectId', ids);
  }
  const rows = await findAll(query);
  for (const row of rows)
    row.set({
      resolved: true,
      resolvedAt: new Date(),
      resolvedBy: actor,
      resolvedByPlatform: false,
    });
  if (rows.length) {
    await Parse.Object.saveAll(rows, MASTER);
    await audit(actor, 'errors.resolved', rows[0], null, { count: rows.length });
  }
  return { resolved: rows.length };
});

// ---- Relay Hosted: the platform console's Errors page. Every restaurant's
// errors, and those that belong to none (the sign-in screen, the console,
// jobs), for Relay's own staff. Restaurants keep their own page as before.

const errorRow = (row) => ({
  id: row.id,
  source: row.get('source'),
  where: row.get('where') || '',
  message: row.get('message'),
  stack: row.get('stack') || '',
  count: Number(row.get('count') || 1),
  firstSeenAt: row.get('firstSeenAt')?.toISOString() || row.createdAt.toISOString(),
  lastSeenAt: row.get('lastSeenAt')?.toISOString() || row.createdAt.toISOString(),
  role: row.get('role') || '',
  userName: row.get('userName') || '',
  userAgent: row.get('userAgent') || '',
  url: row.get('url') || '',
  appVersion: row.get('appVersion') || '',
  resolved: !!row.get('resolved'),
  resolvedAt: row.get('resolvedAt')?.toISOString() || null,
});

const restaurantOf = (row) => {
  const tenant = row.get('tenant');
  return tenant
    ? { id: tenant.id, name: tenant.get('name') || '', code: tenant.get('code') || '' }
    : { id: 'none', name: 'No restaurant (sign-in screen, platform console)', code: '' };
};

// Platform: { state: 'open' | 'fixed', restaurant?: id | 'none' } → the same
// problem in several restaurants is one entry (by fingerprint), with a count
// across all of them and the restaurants it hit.
Parse.Cloud.define('platformListErrors', async (request) => {
  await require('./restaurants').requirePlatform(request);
  const p = request.params || {};
  const state = p.state === 'fixed' ? 'fixed' : 'open';
  const wanted = String(p.restaurant || '');
  return tenancy.withoutTenant(async () => {
    const query = new Parse.Query('ErrorLog');
    query.include('tenant');
    const all = await findAll(query).catch(() => []);
    const restaurants = new Map();
    for (const row of all) {
      const r = restaurantOf(row);
      const entry = restaurants.get(r.id) || { ...r, open: 0 };
      if (!row.get('resolved')) entry.open += 1;
      restaurants.set(r.id, entry);
    }
    const group = (rows) => {
      const groups = new Map();
      for (const row of rows) {
        const key = row.get('fingerprint') || row.id;
        const g = groups.get(key) || { rows: [], hits: new Map() };
        g.rows.push(row);
        const r = restaurantOf(row);
        g.hits.set(r.id, r);
        groups.set(key, g);
      }
      return [...groups.entries()].map(([fingerprint, g]) => {
        const latest = g.rows.reduce((a, b) =>
          (b.get('lastSeenAt') || 0) > (a.get('lastSeenAt') || 0) ? b : a,
        );
        const first = g.rows.reduce((a, b) =>
          (b.get('firstSeenAt') || b.createdAt) < (a.get('firstSeenAt') || a.createdAt) ? b : a,
        );
        return {
          ...errorRow(latest),
          id: fingerprint,
          count: g.rows.reduce((sum, row) => sum + Number(row.get('count') || 1), 0),
          firstSeenAt: first.get('firstSeenAt')?.toISOString() || first.createdAt.toISOString(),
          restaurants: [...g.hits.values()],
        };
      });
    };
    const open = group(all.filter((row) => !row.get('resolved')));
    const inState = state === 'fixed' ? group(all.filter((row) => row.get('resolved'))) : open;
    const rows = inState
      .filter((row) => !wanted || row.restaurants.some((r) => r.id === wanted))
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
      .slice(0, 300);
    return {
      open: open.length,
      rows,
      restaurants: [...restaurants.values()].sort(
        (a, b) => b.open - a.open || a.name.localeCompare(b.name),
      ),
    };
  });
});

// Platform: mark problems fixed in every restaurant they hit, so each
// restaurant's own Errors page shows them fixed too ("Fixed by Relay").
// { ids: fingerprints } or { all: true, restaurant? }.
Parse.Cloud.define('platformResolveErrors', async (request) => {
  const actor = await require('./restaurants').requirePlatform(request);
  const p = request.params || {};
  return tenancy.withoutTenant(async () => {
    const query = new Parse.Query('ErrorLog');
    query.notEqualTo('resolved', true);
    if (p.all) {
      const wanted = String(p.restaurant || '');
      if (wanted === 'none') query.doesNotExist('tenant');
      else if (wanted)
        query.equalTo('tenant', { __type: 'Pointer', className: 'Restaurant', objectId: wanted });
    } else {
      const ids = Array.isArray(p.ids) ? p.ids.map(String).slice(0, 500) : [];
      if (!ids.length) throw invalid('Choose the errors to mark as fixed');
      query.containedIn('fingerprint', ids);
    }
    const rows = await findAll(query);
    for (const row of rows)
      row.set({
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: actor,
        resolvedByPlatform: true,
      });
    if (rows.length) {
      await Parse.Object.saveAll(rows, MASTER);
      await audit(actor, 'platform.errors_resolved', rows[0], null, {
        count: rows.length,
        restaurants: new Set(rows.map((row) => row.get('tenant')?.id || 'none')).size,
      });
    }
    return { resolved: rows.length };
  });
});

module.exports = { recordError };
