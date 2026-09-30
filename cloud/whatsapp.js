// WhatsApp daily summaries (Admin → WhatsApp): the day's Z-report sent to the
// owner's chosen numbers through the WhatsApp Business Cloud API (Meta), when
// the nightly Z-report is saved (owner.js zReportDue).
//
// Messages a business starts must use a template WhatsApp has approved; the
// owner creates one with a single {{1}} in its body (e.g. "Daily summary:
// {{1}}") and enters its name. Without a template the summary goes as plain
// text, which WhatsApp only delivers to numbers that messaged the business in
// the last 24 hours (good for testing).
//
// The access token is kept in Secret and never sent back to the app.
// RELAY_WHATSAPP_URL points the calls elsewhere (the e2e stand-in).

const { MASTER, invalid, audit, loadConfig } = require('./lib/core');
const { requireAdminUnlock } = require('./adminLock');
const { money } = require('./notifications');
const { log, errorMessage } = require('./lib/log');
const { sharedSender } = require('./lib/whatsappSender');

const SECRET_KEY = 'whatsapp';
const API = () => process.env.RELAY_WHATSAPP_URL || 'https://graph.facebook.com/v20.0';
const MAX_RECIPIENTS = 10;

async function secretRow() {
  return new Parse.Query('Secret').equalTo('key', SECRET_KEY).ascending('createdAt').first(MASTER);
}
async function loadSettings() {
  const row = await secretRow();
  return { row, settings: { language: 'en', recipients: [], ...(row?.get('value') || {}) } };
}
async function saveSettings(row, settings) {
  const target = row || new Parse.Object('Secret');
  target.set({ key: SECRET_KEY, value: settings });
  target.setACL(new Parse.ACL());
  await target.save(null, MASTER);
}

// '0772 123456' → '256772123456' (the restaurant's dialling code).
function phoneOf(value, dialCode = '256') {
  let digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = `${dialCode}${digits.slice(1)}`;
  return /^\d{9,15}$/.test(digits) ? digits : '';
}

// The summary: lines for a text message, and one line for a template's {{1}}
// (template values may not contain line breaks).
function summaryOf(config, day, data) {
  const m = (n) => money(config, n || 0);
  const p = data.payments || {};
  const lines = [
    `${config.restaurantName} · Z-report ${day}`,
    `Orders: ${data.orders.delivered} delivered of ${data.orders.placed} placed` +
      (data.orders.cancelled ? `, ${data.orders.cancelled} cancelled` : ''),
    `Sales: ${m(data.sales.total)} · kept after rider pay ${m(data.sales.kept)}`,
    `Paid by: cash ${m(p.cash)} · mobile money ${m(p.mobileMoneyVerified)}` +
      (p.cardVerified ? ` · card ${m(p.cardVerified)}` : ''),
    p.mobileMoneyPending || p.cardPending
      ? `Still to check: ${m((p.mobileMoneyPending || 0) + (p.cardPending || 0))}`
      : '',
    data.till?.cashWithRidersNow ? `Cash still with riders: ${m(data.till.cashWithRidersNow)}` : '',
    (data.shifts || []).some((s) => s.variance)
      ? `Till differences: ${m(data.shifts.reduce((n, s) => n + Math.abs(s.variance || 0), 0))}`
      : '',
  ].filter(Boolean);
  // A shared sender (Relay Hosted) writes for many restaurants, so its
  // template line starts with the restaurant's name.
  return { text: lines.join('\n'), line: lines.slice(1).join(' | '), full: lines.join(' | ') };
}

// How to send: the restaurant's own WhatsApp app, or the shared one when the
// platform provides it (then the restaurant only chooses the numbers).
async function senderFor(settings) {
  const shared = await sharedSender();
  if (!shared) return { ...settings, managed: false };
  return {
    ...shared,
    enabled: settings.enabled,
    recipients: settings.recipients || [],
    managed: true,
  };
}

async function send(settings, to, summary) {
  const body = settings.templateName
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: settings.templateName,
          language: { code: settings.language || 'en' },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: settings.managed ? summary.full : summary.line }],
            },
          ],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: summary.text } };
  const response = await fetch(`${API()}/${encodeURIComponent(settings.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `WhatsApp answered ${response.status}`);
  return json?.messages?.[0]?.id || '';
}

// Sends the summary to every number; returns { sent, failed, error }.
async function sendAll(settings, summary) {
  let sent = 0;
  const errors = [];
  for (const to of settings.recipients || []) {
    try {
      await send(settings, to, summary);
      sent += 1;
    } catch (error) {
      errors.push(`${to}: ${errorMessage(error)}`);
    }
  }
  return { sent, failed: errors.length, error: errors.join('; ').slice(0, 500) };
}

const ready = (settings) =>
  settings.enabled === true &&
  !!settings.token &&
  !!settings.phoneNumberId &&
  (settings.recipients || []).length > 0;

// Called when the nightly Z-report is saved. Once per day.
const inPlan = async () => (await require('./lib/limits').features()).whatsapp !== false;

async function sendDailySummary(day, data, config) {
  if (!(await inPlan())) return null;
  const { row, settings } = await loadSettings();
  const sender = await senderFor(settings);
  if (!ready(sender) || settings.lastSentDay === day) return null;
  const result = await sendAll(sender, summaryOf(config, day, data));
  await saveSettings(row, {
    ...settings,
    lastSentDay: day,
    lastResult: { day, at: new Date().toISOString(), ...result },
  });
  if (result.failed)
    log('warn', 'whatsapp.summary_failed', { day, failed: result.failed, error: result.error });
  return result;
}

const view = (settings, shared = null) => ({
  // Relay Hosted: the platform's WhatsApp sends; only the numbers are theirs.
  managed: !!shared,
  sender: shared?.displayNumber || '',
  enabled: settings.enabled === true,
  phoneNumberId: settings.phoneNumberId || '',
  tokenSet: !!settings.token,
  templateName: settings.templateName || '',
  language: settings.language || 'en',
  recipients: settings.recipients || [],
  lastResult: settings.lastResult || null,
});

Parse.Cloud.define('adminGetWhatsAppSettings', async (request) => {
  await requireAdminUnlock(request);
  return view((await loadSettings()).settings, await sharedSender());
});

// { enabled, phoneNumberId, token (empty keeps the saved one), templateName,
//   language, recipients: [phone] }
Parse.Cloud.define('adminSaveWhatsAppSettings', async (request) => {
  const actor = await requireAdminUnlock(request);
  const p = request.params;
  const { row, settings } = await loadSettings();
  const { values: config } = await loadConfig();
  const recipients = (Array.isArray(p.recipients) ? p.recipients : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (recipients.length > MAX_RECIPIENTS) throw invalid(`At most ${MAX_RECIPIENTS} numbers`);
  const numbers = recipients.map((value) => phoneOf(value, config.momoDialCode || '256'));
  const bad = recipients.find((_, i) => !numbers[i]);
  if (bad) throw invalid(`"${bad}" is not a phone number`);
  const next = {
    ...settings,
    enabled: p.enabled === true,
    phoneNumberId: String(p.phoneNumberId ?? settings.phoneNumberId ?? '')
      .replace(/[^\d]/g, '')
      .slice(0, 30),
    templateName: String(p.templateName ?? settings.templateName ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 60),
    language: String(p.language || settings.language || 'en')
      .trim()
      .slice(0, 10),
    recipients: [...new Set(numbers)],
  };
  if (p.token) next.token = String(p.token).trim().slice(0, 1000);
  const shared = await sharedSender();
  if (next.enabled && !(await inPlan()))
    throw invalid('WhatsApp summaries are not part of your plan');
  if (next.enabled && shared && !next.recipients.length)
    throw invalid('Enter at least one number to send the summary to');
  if (next.enabled && !ready(await senderFor(next)))
    throw invalid('Enter the phone number ID, the access token and at least one number');
  await saveSettings(row, next);
  await audit(
    actor,
    'whatsapp.saved',
    { className: 'Secret', id: SECRET_KEY },
    view(settings, shared),
    view(next, shared),
  );
  return view(next, shared);
});

// Owner: send today's summary so far, now, to check the connection.
Parse.Cloud.define('adminTestWhatsApp', async (request) => {
  await requireAdminUnlock(request);
  if (!(await inPlan())) throw invalid('WhatsApp summaries are not part of your plan');
  const { settings } = await loadSettings();
  const sender = await senderFor(settings);
  if (!sender.token || !sender.phoneNumberId || !sender.recipients.length)
    throw invalid(
      sender.managed
        ? 'Save at least one number first'
        : 'Save the phone number ID, the access token and at least one number first',
    );
  const { values: config } = await loadConfig();
  const { buildZReport } = require('./owner');
  const { isoDay } = require('./lib/dates');
  const day = isoDay(new Date(), config.timezone);
  const result = await sendAll(sender, summaryOf(config, day, await buildZReport(day, config)));
  if (!result.sent) throw invalid(`Not sent: ${result.error}`);
  return result;
});

module.exports = { sendDailySummary, summaryOf, phoneOf, send };
