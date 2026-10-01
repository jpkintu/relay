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
  return {
    row,
    email: { provider: 'resend', fromName: 'RelayEats', ...(row?.get('email') || {}) },
  };
}

const ready = (email) => !!(email.apiKey && email.from && PROVIDERS[email.provider]);
const validEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim()) &&
  String(value).trim().length <= 120;

// Sends one email: { to, subject, text, html? }, or with `template: { id,
// variables }` the service's own template (Resend: its ID or alias; Brevo:
// its number), which then holds the subject and the body. Throws when the
// service refuses it.
async function sendWith(email, { to, subject, text, html, template }) {
  const base = process.env.RELAY_EMAIL_URL || PROVIDERS[email.provider];
  const name = String(email.fromName || 'RelayEats').replace(/[<>"]/g, '');
  const request =
    email.provider === 'brevo'
      ? {
          url: `${base}/smtp/email`,
          headers: { 'api-key': email.apiKey },
          body: {
            sender: { name, email: email.from },
            to: [{ email: to }],
            ...(template
              ? { templateId: Number(template.id), params: template.variables }
              : { subject, textContent: text, ...(html ? { htmlContent: html } : {}) }),
          },
        }
      : {
          url: `${base}/emails`,
          headers: { Authorization: `Bearer ${email.apiKey}` },
          body: {
            from: `${name} <${email.from}>`,
            to: [to],
            ...(template
              ? { template: { id: template.id, variables: template.variables } }
              : { subject, text, ...(html ? { html } : {}) }),
          },
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

// A template ID the provider can take: Resend IDs and aliases, Brevo numbers.
const validTemplate = (provider, id) =>
  provider === 'brevo' ? /^[0-9]{1,9}$/.test(id) : /^[A-Za-z0-9_-]{1,100}$/.test(id);

// One kind of email (lib/emailTemplates.js) with its variables: through the
// template set for it in the console, else Relay's own copy.
function messageOf(email, kind, to, variables) {
  const built = require('./emailTemplates').render(kind, variables);
  const id = String(email.templates?.[kind] || '').trim();
  return {
    to,
    subject: built.subject,
    text: built.text,
    html: built.html,
    template: id && validTemplate(email.provider, id) ? { id, variables: built.variables } : null,
  };
}
const sendKind = (email, kind, to, variables) =>
  sendWith(email, messageOf(email, kind, to, variables));

// Sends with the platform's settings; false when email is not set up.
async function sendEmail(kind, to, variables) {
  const { email } = await loadEmail();
  if (!ready(email) || !validEmail(to)) return false;
  await sendKind(email, kind, to, variables);
  return true;
}

module.exports = {
  loadEmail,
  sendWith,
  sendKind,
  sendEmail,
  messageOf,
  ready,
  validEmail,
  validTemplate,
  PROVIDERS,
};
