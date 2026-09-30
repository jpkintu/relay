// Relay Hosted: email from the platform (password resets, welcome, billing
// reminders) through an email service's HTTP API. Platform staff choose the
// service and enter its key in the platform console (cloud/platformEmail.js).
// Supported: Resend (resend.com) and Brevo (brevo.com). RELAY_EMAIL_URL
// points the calls elsewhere (the e2e stand-in).

const MASTER = { useMasterKey: true };
const PROVIDERS = {
  resend: 'https://api.resend.com',
  brevo: 'https://api.brevo.com/v3',
};

// The saved settings: { provider, apiKey, from, fromName, appUrl }. Kept on
// PlatformSettings (master key only), outside the settings the console lists.
async function loadEmail() {
  const tenancy = require('./tenant');
  const row = await tenancy.withoutTenant(() => new Parse.Query('PlatformSettings').first(MASTER));
  return { row, email: { provider: 'resend', fromName: 'Relay', ...(row?.get('email') || {}) } };
}

const ready = (email) => !!(email.apiKey && email.from && PROVIDERS[email.provider]);
const validEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim()) &&
  String(value).trim().length <= 120;

// Sends one plain-text email. Throws when the service refuses it.
async function sendWith(email, { to, subject, text }) {
  const base = process.env.RELAY_EMAIL_URL || PROVIDERS[email.provider];
  const name = String(email.fromName || 'Relay').replace(/[<>"]/g, '');
  const request =
    email.provider === 'brevo'
      ? {
          url: `${base}/smtp/email`,
          headers: { 'api-key': email.apiKey },
          body: {
            sender: { name, email: email.from },
            to: [{ email: to }],
            subject,
            textContent: text,
          },
        }
      : {
          url: `${base}/emails`,
          headers: { Authorization: `Bearer ${email.apiKey}` },
          body: { from: `${name} <${email.from}>`, to: [to], subject, text },
        };
  const response = await fetch(request.url, {
    method: 'POST',
    headers: { ...request.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(
      json?.message || json?.error?.message || `Email service answered ${response.status}`,
    );
  }
}

// Sends with the platform's settings; false when email is not set up.
async function sendEmail(message) {
  const { email } = await loadEmail();
  if (!ready(email) || !validEmail(message.to)) return false;
  await sendWith(email, message);
  return true;
}

module.exports = { loadEmail, sendWith, sendEmail, ready, validEmail, PROVIDERS };
