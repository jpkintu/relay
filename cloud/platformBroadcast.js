// Relay Hosted: platform staff email restaurant owners from the console
// (announcements, price changes, maintenance notices). One email per owner,
// sent in the background through the email service (lib/email.js) as the
// `announcement` kind (lib/emailTemplates.js); each send is a
// PlatformBroadcast row with its audience and how many went out.

const { MASTER, invalid, audit } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { accessOf } = require('./lib/access');
const { requirePlatform, platformSettings } = require('./restaurants');
const { loadEmail, ready, validEmail, sendKind } = require('./lib/email');
const { ownerVariables } = require('./platformEmail');
const { log, errorMessage } = require('./lib/log');

const STATUSES = ['all', 'trial', 'active', 'past_due', 'expired'];
// Pause between emails (Resend allows a couple a second).
const delayMs = () => Number(process.env.RELAY_BROADCAST_DELAY_MS ?? 600);

// {restaurant} and {owner} in the subject or message become each
// restaurant's own.
const personal = (text, row) =>
  String(text)
    .replace(/\{restaurant\}/gi, row.get('name') || '')
    .replace(/\{owner\}/gi, row.get('ownerName') || '');

function audienceOf(params) {
  const status = STATUSES.includes(params?.status) ? params.status : 'all';
  const plan = String(params?.plan || '');
  return { status, plan };
}

// The restaurants the audience covers (never suspended ones), and how many
// of them have no owner email.
async function recipients(audience) {
  const { values: platform } = await platformSettings();
  const query = new Parse.Query('Restaurant');
  query.notEqualTo('suspended', true);
  const rows = await tenancy.withoutTenant(() => query.findAll({ ...MASTER, batchSize: 500 }));
  const chosen = rows.filter((row) => {
    if (audience.plan && require('./lib/limits').planOf(row) !== audience.plan) return false;
    if (audience.status === 'all') return true;
    return accessOf(row, platform.graceDays).status === audience.status;
  });
  return {
    platform,
    rows: chosen.filter((row) => validEmail(row.get('ownerEmail'))),
    withoutEmail: chosen.filter((row) => !validEmail(row.get('ownerEmail'))).length,
  };
}

function checkMessage(params) {
  const subject = String(params?.subject || '').trim();
  const message = String(params?.message || '').trim();
  if (subject.length < 3 || subject.length > 150) throw invalid('Subject: 3 to 150 characters');
  if (message.length < 10 || message.length > 5000)
    throw invalid('Message: 10 to 5,000 characters');
  return { subject, message };
}

const view = (row) => ({
  id: row.id,
  subject: row.get('subject'),
  message: row.get('message'),
  audience: row.get('audience') || { status: 'all', plan: '' },
  total: row.get('total') || 0,
  sent: row.get('sent') || 0,
  failed: row.get('failed') || 0,
  state: row.get('state') || 'done',
  by: row.get('byName') || '',
  createdAt: row.createdAt?.toISOString() || null,
  finishedAt: row.get('finishedAt')?.toISOString() || null,
});

// Platform: { status, plan } → how many owners it would reach.
Parse.Cloud.define('platformBroadcastPreview', async (request) => {
  await requirePlatform(request);
  const { rows, withoutEmail } = await recipients(audienceOf(request.params));
  return {
    count: rows.length,
    withoutEmail,
    sample: rows.slice(0, 5).map((row) => row.get('name')),
  };
});

// Platform: { subject, message, status, plan, testTo? }. With testTo, one
// email there (as the first restaurant in the audience would get it);
// otherwise every owner in the audience, in the background.
Parse.Cloud.define('platformSendBroadcast', async (request) => {
  const actor = await requirePlatform(request);
  const { subject, message } = checkMessage(request.params);
  const audience = audienceOf(request.params);
  const { email } = await loadEmail();
  if (!ready(email)) throw invalid('Set up the email service first (Email, above)');
  const { platform, rows } = await recipients(audience);
  const variables = (row) => ({
    ...ownerVariables(row, platform),
    SUBJECT: personal(subject, row),
    MESSAGE: personal(message, row),
  });

  const testTo = String(request.params?.testTo || '')
    .trim()
    .toLowerCase();
  if (testTo) {
    if (!validEmail(testTo)) throw invalid('Enter the address to send the test to');
    const example = rows[0] || {
      get: (key) => ({ name: 'Your restaurant', ownerName: 'there' })[key] || '',
    };
    try {
      await sendKind(email, 'announcement', testTo, variables(example));
    } catch (error) {
      throw invalid(`Not sent: ${errorMessage(error)}`);
    }
    return { test: true, sent: 1 };
  }
  if (!rows.length) throw invalid('No owner in this audience has an email address');

  const row = new Parse.Object('PlatformBroadcast');
  row.set({
    subject,
    message,
    audience,
    total: rows.length,
    sent: 0,
    failed: 0,
    state: 'sending',
    byName: actor.get('name') || actor.getUsername(),
  });
  row.setACL(new Parse.ACL());
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.broadcast_sent', row, null, { subject, audience, total: rows.length }),
  );

  // In the background: the console follows the counts.
  void (async () => {
    let sent = 0;
    let failed = 0;
    for (const [index, restaurant] of rows.entries()) {
      try {
        await sendKind(email, 'announcement', restaurant.get('ownerEmail'), variables(restaurant));
        sent += 1;
      } catch (error) {
        failed += 1;
        log('warn', 'broadcast.email_failed', {
          broadcast: row.id,
          restaurant: restaurant.id,
          error: errorMessage(error),
        });
      }
      if (index % 10 === 9 || index === rows.length - 1) {
        row.set({ sent, failed });
        if (index === rows.length - 1) row.set({ state: 'done', finishedAt: new Date() });
        await tenancy.withoutTenant(() => row.save(null, MASTER));
      }
      if (delayMs() > 0 && index < rows.length - 1)
        await new Promise((resolve) => setTimeout(resolve, delayMs()));
    }
  })().catch((error) =>
    log('error', 'broadcast.failed', { broadcast: row.id, error: errorMessage(error) }),
  );
  return view(row);
});

// Platform: the last sends, newest first.
Parse.Cloud.define('platformListBroadcasts', async (request) => {
  await requirePlatform(request);
  const query = new Parse.Query('PlatformBroadcast');
  query.descending('createdAt');
  query.limit(20);
  const rows = await tenancy.withoutTenant(() => query.find(MASTER));
  return { rows: rows.map(view) };
});
