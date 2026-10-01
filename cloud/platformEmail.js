// Relay Hosted: the restaurant owner's email (collected at sign-up) and what
// the platform sends to it: the password reset link, the welcome email and
// billing reminders (lib/email.js).

const crypto = require('crypto');
const { MASTER, invalid, audit, endSessions, requireRole } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { requirePlatform } = require('./restaurants');
const {
  loadEmail,
  sendWith,
  sendKind,
  sendEmail,
  ready,
  validEmail,
  validTemplate,
  PROVIDERS,
} = require('./lib/email');
const { KINDS, SAMPLE } = require('./lib/emailTemplates');
const { log, errorMessage } = require('./lib/log');

const RESET_MS = 3600000;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const cleanEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const view = (email) => ({
  provider: email.provider || 'resend',
  from: email.from || '',
  fromName: email.fromName || 'Relay',
  appUrl: email.appUrl || '',
  keySet: !!email.apiKey,
  ready: ready(email),
  providers: Object.keys(PROVIDERS),
  // The template set for each kind of email ('' = Relay's own copy).
  templates: Object.fromEntries(
    Object.keys(KINDS).map((kind) => [kind, String(email.templates?.[kind] || '')]),
  ),
  kinds: Object.entries(KINDS).map(([key, spec]) => ({
    key,
    label: spec.label,
    when: spec.when,
    subject: spec.subject,
    variables: spec.variables,
  })),
});

// ---------------------------------------------------------------------------
// Platform console → Email

Parse.Cloud.define('platformGetEmail', async (request) => {
  await requirePlatform(request);
  return view((await loadEmail()).email);
});

// { provider, apiKey (empty keeps it), from, fromName, appUrl, templates? }
// `templates`: { kind: template ID or alias at the service, '' for Relay's own }.
Parse.Cloud.define('platformSaveEmail', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const { row, email } = await loadEmail();
  if (!row) throw invalid('Save the platform settings first');
  const provider = String(p.provider || email.provider || 'resend');
  if (!PROVIDERS[provider]) throw invalid('Choose Resend or Brevo');
  const from = cleanEmail(p.from ?? email.from);
  if (from && !validEmail(from)) throw invalid('The sender address is not an email address');
  const appUrl = String(p.appUrl ?? email.appUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (appUrl && !/^https?:\/\/[^\s/]+/.test(appUrl))
    throw invalid('The app address starts with https://');
  const next = {
    ...email,
    provider,
    from,
    fromName: String(p.fromName ?? email.fromName ?? 'Relay')
      .trim()
      .slice(0, 60),
    appUrl,
  };
  if (p.templates && typeof p.templates === 'object') {
    const templates = {};
    for (const [kind, value] of Object.entries(p.templates)) {
      if (!KINDS[kind]) continue;
      const id = String(value ?? '').trim();
      if (!id) continue;
      if (!validTemplate(provider, id))
        throw invalid(
          provider === 'brevo'
            ? `${KINDS[kind].label}: a Brevo template is its number`
            : `${KINDS[kind].label}: use the Resend template ID or alias (letters, numbers, - and _)`,
        );
      templates[kind] = id;
    }
    next.templates = templates;
  }
  if (p.apiKey) next.apiKey = String(p.apiKey).trim().slice(0, 500);
  row.set('email', next);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.email_saved', row, view(email), view(next)),
  );
  return view(next);
});

// { kind } → the email's HTML ready to paste into a Resend template (and the
// Brevo version), its subject and variables.
Parse.Cloud.define('platformEmailTemplate', async (request) => {
  await requirePlatform(request);
  const spec = KINDS[String(request.params?.kind || '')];
  if (!spec) throw invalid('Unknown kind of email');
  const { forBrevo } = require('./lib/emailTemplates');
  return {
    subject: spec.subject,
    variables: spec.variables,
    html: spec.html,
    brevoHtml: forBrevo(spec.html),
    brevoSubject: forBrevo(spec.subject),
  };
});

// { to, kind?, template? }: a plain test, or one kind of email with example
// values (through `template`, else its saved template, when one is set).
Parse.Cloud.define('platformTestEmail', async (request) => {
  await requirePlatform(request);
  const to = cleanEmail(request.params?.to);
  const kind = request.params?.kind ? String(request.params.kind) : '';
  if (kind && !KINDS[kind]) throw invalid('Unknown kind of email');
  if (!validEmail(to)) throw invalid('Enter the email address to send the test to');
  const { email } = await loadEmail();
  if (!ready(email)) throw invalid('Save the service, its API key and the sender address first');
  // `template`: the ID typed in the console, tried before it is saved.
  let templates = email.templates || {};
  if (kind && request.params?.template !== undefined) {
    const id = String(request.params.template ?? '').trim();
    if (id && !validTemplate(email.provider, id))
      throw invalid(
        email.provider === 'brevo'
          ? 'A Brevo template is its number'
          : 'Use the Resend template ID or alias (letters, numbers, - and _)',
      );
    templates = { ...templates, [kind]: id };
  }
  try {
    if (kind) {
      await sendKind({ ...email, templates }, kind, to, SAMPLE);
      return { sent: 1, template: String(templates[kind] || '') };
    }
    await sendWith(email, {
      to,
      subject: 'Relay test email',
      text: 'Email from Relay works. Owners will get password reset links and reminders like this.',
    });
  } catch (error) {
    throw invalid(`Not sent: ${errorMessage(error)}`);
  }
  return { sent: 1 };
});

// ---------------------------------------------------------------------------
// The owner's email

// Owner: change the email Relay writes to. { email }
Parse.Cloud.define('updateOwnerEmail', async (request) => {
  const { user } = await requireRole(request, ['admin']);
  const email = cleanEmail(request.params?.email);
  if (!validEmail(email)) throw invalid('Enter a valid email address');
  const tenant = tenancy.current();
  const row = await tenancy.withoutTenant(() => new Parse.Query('Restaurant').get(tenant, MASTER));
  const before = row.get('ownerEmail') || '';
  row.set('ownerEmail', email);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  tenancy.clearCache();
  await audit(user, 'restaurant.owner_email_changed', row, { email: before }, { email });
  return { email };
});

// ---------------------------------------------------------------------------
// Forgot password (owner sign-in)

// Requests are limited per address and restaurant.
const recent = new Map();
function allow(key) {
  const now = Date.now();
  const times = (recent.get(key) || []).filter((time) => now - time < 3600000);
  if (times.length >= 5) return false;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

// Anyone: { code, email } → emails a reset link to the owner when the email
// is the restaurant's. The answer is the same either way.
Parse.Cloud.define('requestOwnerReset', async (request) => {
  const p = request.params || {};
  const code = String(p.code || '')
    .trim()
    .toLowerCase();
  const email = cleanEmail(p.email);
  if (!code || !validEmail(email)) throw invalid('Enter the restaurant code and your email');
  const { email: settings } = await loadEmail();
  if (!ready(settings) || !settings.appUrl)
    throw invalid('Password reset by email is not set up yet. Ask Relay support to reset it');
  if (!request.master && !allow(`${request.ip || 'unknown'}:${code}`))
    throw invalid('Too many requests. Try again in an hour');
  const done = { sent: true };
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').equalTo('code', code).first(MASTER),
  );
  if (!row || cleanEmail(row.get('ownerEmail')) !== email) return done;
  const token = crypto.randomBytes(32).toString('hex');
  row.set({ resetTokenHash: hash(token), resetTokenExpires: new Date(Date.now() + RESET_MS) });
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  const link = `${settings.appUrl}/?reset=${token}`;
  try {
    await sendKind(settings, 'password_reset', email, {
      ...ownerVariables(row),
      RESET_URL: link,
      EXPIRES_IN: 'an hour',
    });
  } catch (error) {
    log('warn', 'email.reset_failed', { restaurant: row.id, error: errorMessage(error) });
    throw invalid('The email could not be sent. Try again later or ask Relay support');
  }
  return done;
});

// Anyone with the link: { token, password } → the owner's new password.
Parse.Cloud.define('completeOwnerReset', async (request) => {
  const p = request.params || {};
  const password = String(p.password || '');
  if (password.length < 6) throw invalid('Choose a password of at least 6 characters');
  const row = await tenancy.withoutTenant(() =>
    new Parse.Query('Restaurant').equalTo('resetTokenHash', hash(p.token)).first(MASTER),
  );
  if (!row || !(row.get('resetTokenExpires') > new Date()))
    throw invalid('This link has expired or was already used. Ask for a new one');
  const owner = await tenancy.runAs(
    row.id,
    async () => {
      const role = await new Parse.Query(Parse.Role).equalTo('name', 'admin').first(MASTER);
      const owners = role ? await role.getUsers().query().ascending('createdAt').find(MASTER) : [];
      const user = owners.find((u) => u.get('active') !== false) || owners[0];
      if (!user) throw invalid('This restaurant has no owner account');
      user.set({ password, active: true });
      await user.save(null, MASTER);
      await endSessions(user);
      await audit(user, 'restaurant.owner_password_reset', row, null, { by: 'email link' });
      return user;
    },
    row.get('code'),
  );
  row.unset('resetTokenHash');
  row.unset('resetTokenExpires');
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  return { code: row.get('code'), username: tenancy.displayUsername(owner.getUsername()) };
});

// What every email to an owner says about the restaurant.
function ownerVariables(row, platform = {}) {
  const support = platform.supportContact || '';
  return {
    OWNER_NAME: row.get('ownerName') || 'there',
    RESTAURANT_NAME: row.get('name') || '',
    SUPPORT_LINE: support ? `Questions? Contact Relay support: ${support}.` : '',
  };
}

// Welcome, billing and payment emails: best effort, never in the way of the
// app. `kind`: lib/emailTemplates.js; `variables` add to the owner's.
async function emailOwner(row, kind, variables = {}, platform = {}) {
  try {
    const { appUrl = '' } = (await loadEmail()).email;
    return await sendEmail(kind, row.get('ownerEmail'), {
      ...ownerVariables(row, platform),
      BILLING_URL: appUrl ? `${appUrl}/admin/site/billing` : '',
      SIGN_IN_URL: appUrl ? `${appUrl}/r/${row.get('code')}` : '',
      ...variables,
    });
  } catch (error) {
    log('warn', 'email.owner_failed', { restaurant: row.id, kind, error: errorMessage(error) });
    return false;
  }
}

module.exports = { emailOwner, ownerVariables, validEmail };
