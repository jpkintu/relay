// Relay Hosted: the emails Relay sends to restaurant owners, one per kind.
//
// Each kind has a subject, an HTML body and a text body with {{{VARIABLE}}}
// placeholders, the syntax of Resend's templates. Relay fills them in itself
// unless platform staff give the kind a template ID of their email service
// (platform console → Email → Templates); then the service renders its own
// template with the same variables. docs/email-templates/ holds these HTML
// bodies ready to paste into Resend (and Brevo's {{ params.X }} version);
// `npm run email:templates` writes them from this file.

// Brand colours of the emails (the app's ink and accent).
const INK = '#0f1b3d';
const ACCENT = '#e8542f';
const MUTED = '#5b6478';
const LINE = '#e3e6ee';

// Variables every email gets.
const COMMON = ['OWNER_NAME', 'RESTAURANT_NAME', 'SUPPORT_LINE'];
const BILLING = [
  'PLAN_NAME',
  'AMOUNT',
  'ANNUAL_AMOUNT',
  'DUE_DATE',
  'INVOICE_NUMBER',
  'BILLING_URL',
];

const row = (label, value) => `
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid ${LINE};color:${MUTED};font-size:14px;">${label}</td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid ${LINE};color:${INK};font-size:14px;font-weight:600;">${value}</td>
              </tr>`;
const details = (rows) => `
          <tr>
            <td style="padding:8px 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.join('')}
              </table>
            </td>
          </tr>`;
const button = (label, url) => `
          <tr>
            <td style="padding:24px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:10px;background:${ACCENT};">
                    <a href="${url}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
const para = (html, style = '') => `
          <tr>
            <td style="padding:0 32px 14px 32px;font-size:16px;line-height:1.55;color:${INK};${style}">${html}</td>
          </tr>`;
const small = (html) => `
          <tr>
            <td style="padding:16px 32px 0 32px;font-size:13px;line-height:1.5;color:${MUTED};">${html}</td>
          </tr>`;

// The frame every email shares: a white card on a light background.
function layout({ title, preheader, tag, heading, blocks }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;">
          <tr>
            <td style="padding:28px 32px 6px 32px;">
              <span style="font-size:18px;font-weight:800;color:${INK};letter-spacing:-0.2px;">Relay</span>
              <span style="font-size:13px;color:${MUTED};">&nbsp;·&nbsp;{{{RESTAURANT_NAME}}}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0 32px;">
              <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${tag.bg};color:${tag.fg};font-size:12px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase;">${tag.label}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 14px 32px;font-size:24px;line-height:1.25;font-weight:800;color:${INK};">${heading}</td>
          </tr>${blocks.join('')}
          <tr>
            <td style="padding:28px 32px 28px 32px;">
              <p style="margin:0;font-size:13px;line-height:1.5;color:${MUTED};">{{{SUPPORT_LINE}}}</p>
              <p style="margin:10px 0 0 0;font-size:12px;line-height:1.5;color:${MUTED};">Sent by Relay to the owner of {{{RESTAURANT_NAME}}}.</p>
            </td>
          </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

const TAGS = {
  info: { label: 'Welcome', bg: '#e8eefc', fg: '#1d3fa8' },
  account: { label: 'Account', bg: '#e8eefc', fg: '#1d3fa8' },
  soon: { label: 'Payment due soon', bg: '#fff3d6', fg: '#8a5a00' },
  today: { label: 'Payment due', bg: '#ffe6dc', fg: '#a8361a' },
  overdue: { label: 'Overdue', bg: '#fde2e2', fg: '#a11a1a' },
  paid: { label: 'Paid', bg: '#dff5e6', fg: '#17653a' },
};

const billingRows = [
  row('Plan', '{{{PLAN_NAME}}}'),
  row('Invoice', '{{{INVOICE_NUMBER}}}'),
  row('Due', '{{{DUE_DATE}}}'),
  row('A month', '{{{AMOUNT}}}'),
  row('A year at once', '{{{ANNUAL_AMOUNT}}}'),
];

// kind → { label, when, subject, variables, html, text }
const KINDS = {
  welcome: {
    label: 'Welcome',
    when: 'Right after a restaurant signs up.',
    subject: 'Welcome to Relay, {{{RESTAURANT_NAME}}}',
    variables: [
      ...COMMON,
      'RESTAURANT_CODE',
      'USERNAME',
      'PLAN_NAME',
      'TRIAL_DAYS',
      'TRIAL_ENDS',
      'SIGN_IN_URL',
    ],
    html: layout({
      title: 'Welcome to Relay',
      preheader: 'Your free trial has started. Here is how to sign in.',
      tag: TAGS.info,
      heading: '{{{RESTAURANT_NAME}}} is ready on Relay',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'Your {{{TRIAL_DAYS}}}-day free trial has started. Add your menu and your team, and orders can start today.',
        ),
        details([
          row('Restaurant code', '{{{RESTAURANT_CODE}}}'),
          row('Your username', '{{{USERNAME}}}'),
          row('Plan', '{{{PLAN_NAME}}}'),
          row('Trial ends', '{{{TRIAL_ENDS}}}'),
        ]),
        button('Sign in to Relay', '{{{SIGN_IN_URL}}}'),
        small(
          'Forgot your password? Use “Forgot password” on the sign-in page and we will email you a link.',
        ),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      '{{{RESTAURANT_NAME}}} is set up on Relay with a {{{TRIAL_DAYS}}}-day free trial (until {{{TRIAL_ENDS}}}).',
      'Restaurant code: {{{RESTAURANT_CODE}}}',
      'Your username: {{{USERNAME}}}',
      'Plan: {{{PLAN_NAME}}}',
      'Sign in: {{{SIGN_IN_URL}}}',
      '',
      'Forgot your password? Use "Forgot password" on the sign-in page and we will email you a link.',
      '',
      '{{{SUPPORT_LINE}}}',
    ].join('\n'),
  },

  password_reset: {
    label: 'Password reset',
    when: 'When the owner asks for a new password on the sign-in page.',
    subject: 'Reset your {{{RESTAURANT_NAME}}} password',
    variables: [...COMMON, 'RESET_URL', 'EXPIRES_IN'],
    html: layout({
      title: 'Reset your password',
      preheader: 'Choose a new owner password. The link works for {{{EXPIRES_IN}}}.',
      tag: TAGS.account,
      heading: 'Reset your password',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'Someone asked to reset the owner password for {{{RESTAURANT_NAME}}} on Relay. Open the link within {{{EXPIRES_IN}}} to choose a new one.',
        ),
        button('Choose a new password', '{{{RESET_URL}}}'),
        small('If it was not you, ignore this email: your password stays as it is.'),
        small(
          'The button not working? Copy this link into your browser:<br /><span style="word-break:break-all;color:#1d3fa8;">{{{RESET_URL}}}</span>',
        ),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      'Someone asked to reset the owner password for {{{RESTAURANT_NAME}}} on Relay.',
      'Open this link within {{{EXPIRES_IN}}} to choose a new one:',
      '{{{RESET_URL}}}',
      '',
      'If it was not you, ignore this email: your password stays as it is.',
    ].join('\n'),
  },

  billing_due_soon: {
    label: 'Payment due soon',
    when: '7 days and again 3 days before the trial or paid period ends.',
    subject: '{{{RESTAURANT_NAME}}}: {{{HEADLINE}}}',
    variables: [...COMMON, ...BILLING, 'HEADLINE', 'DAYS_LEFT'],
    html: layout({
      title: 'Payment due soon',
      preheader: '{{{HEADLINE}}}. Pay {{{AMOUNT}}} by {{{DUE_DATE}}} to keep Relay open.',
      tag: TAGS.soon,
      heading: '{{{HEADLINE}}}',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'To keep {{{RESTAURANT_NAME}}} running on Relay without a break, pay before <strong>{{{DUE_DATE}}}</strong>. You can pay a month, a few months, or a whole year at once and get two months free.',
        ),
        details(billingRows),
        button('Pay now', '{{{BILLING_URL}}}'),
        small(
          'Pay with MTN MoMo or Airtel Money in Admin → Billing, where you can also download this invoice.',
        ),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      '{{{HEADLINE}}}. To keep {{{RESTAURANT_NAME}}} running on Relay, pay before {{{DUE_DATE}}}.',
      '',
      'Plan: {{{PLAN_NAME}}}',
      'Invoice: {{{INVOICE_NUMBER}}}',
      'A month: {{{AMOUNT}}}',
      'A year at once: {{{ANNUAL_AMOUNT}}}',
      '',
      'Pay in Admin → Billing: {{{BILLING_URL}}}',
      '',
      '{{{SUPPORT_LINE}}}',
    ].join('\n'),
  },

  billing_due_today: {
    label: 'Payment due today',
    when: 'On the last day of the trial or paid period.',
    subject: '{{{RESTAURANT_NAME}}}: {{{HEADLINE}}}',
    variables: [...COMMON, ...BILLING, 'HEADLINE'],
    html: layout({
      title: 'Payment due',
      preheader: '{{{HEADLINE}}}. Pay {{{AMOUNT}}} to keep Relay open.',
      tag: TAGS.today,
      heading: '{{{HEADLINE}}}',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'Your payment for {{{RESTAURANT_NAME}}} is due on <strong>{{{DUE_DATE}}}</strong>. Pay now so your team can keep taking orders.',
        ),
        details(billingRows),
        button('Pay now', '{{{BILLING_URL}}}'),
        small('Already paid? Thank you — you can ignore this email.'),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      '{{{HEADLINE}}}. Your payment for {{{RESTAURANT_NAME}}} is due on {{{DUE_DATE}}}.',
      '',
      'Plan: {{{PLAN_NAME}}}',
      'Invoice: {{{INVOICE_NUMBER}}}',
      'A month: {{{AMOUNT}}}',
      'A year at once: {{{ANNUAL_AMOUNT}}}',
      '',
      'Pay in Admin → Billing: {{{BILLING_URL}}}',
      '',
      'Already paid? Thank you, you can ignore this email.',
      '{{{SUPPORT_LINE}}}',
    ].join('\n'),
  },

  billing_overdue: {
    label: 'Payment overdue',
    when: 'When the period has ended (grace days), and again the day before the app closes.',
    subject: '{{{RESTAURANT_NAME}}}: {{{HEADLINE}}}',
    variables: [...COMMON, ...BILLING, 'HEADLINE', 'CLOSES_ON', 'DAYS_TO_CLOSE'],
    html: layout({
      title: 'Payment overdue',
      preheader: '{{{HEADLINE}}}. Pay {{{AMOUNT}}} before {{{CLOSES_ON}}}.',
      tag: TAGS.overdue,
      heading: '{{{HEADLINE}}}',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'The payment for {{{RESTAURANT_NAME}}} was due on {{{DUE_DATE}}}. The app keeps working until <strong>{{{CLOSES_ON}}}</strong>; after that only you can sign in, to pay.',
        ),
        details([...billingRows, row('App closes', '{{{CLOSES_ON}}}')]),
        button('Pay now', '{{{BILLING_URL}}}'),
        small('Already paid? Thank you — you can ignore this email.'),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      '{{{HEADLINE}}}. The payment for {{{RESTAURANT_NAME}}} was due on {{{DUE_DATE}}}.',
      'The app keeps working until {{{CLOSES_ON}}}; after that only you can sign in, to pay.',
      '',
      'Plan: {{{PLAN_NAME}}}',
      'Invoice: {{{INVOICE_NUMBER}}}',
      'A month: {{{AMOUNT}}}',
      'A year at once: {{{ANNUAL_AMOUNT}}}',
      '',
      'Pay in Admin → Billing: {{{BILLING_URL}}}',
      '',
      '{{{SUPPORT_LINE}}}',
    ].join('\n'),
  },

  payment_received: {
    label: 'Payment received',
    when: 'When a subscription payment is received (in the app or recorded by platform staff).',
    subject: '{{{RESTAURANT_NAME}}}: payment received, thank you',
    variables: [
      ...COMMON,
      'PLAN_NAME',
      'AMOUNT',
      'PERIOD',
      'PAID_UNTIL',
      'INVOICE_NUMBER',
      'REFERENCE',
      'BILLING_URL',
    ],
    html: layout({
      title: 'Payment received',
      preheader: 'We received {{{AMOUNT}}}. Relay is paid until {{{PAID_UNTIL}}}.',
      tag: TAGS.paid,
      heading: 'Payment received, thank you',
      blocks: [
        para('Hello {{{OWNER_NAME}}},'),
        para(
          'We received your payment for {{{RESTAURANT_NAME}}}. Relay is paid until <strong>{{{PAID_UNTIL}}}</strong>.',
        ),
        details([
          row('Invoice', '{{{INVOICE_NUMBER}}}'),
          row('Plan', '{{{PLAN_NAME}}}'),
          row('Paid for', '{{{PERIOD}}}'),
          row('Amount', '{{{AMOUNT}}}'),
          row('Reference', '{{{REFERENCE}}}'),
          row('Paid until', '{{{PAID_UNTIL}}}'),
        ]),
        button('View invoices', '{{{BILLING_URL}}}'),
        small('Download the paid invoice as a PDF in Admin → Billing.'),
      ],
    }),
    text: [
      'Hello {{{OWNER_NAME}}},',
      '',
      'We received your payment for {{{RESTAURANT_NAME}}}. Relay is paid until {{{PAID_UNTIL}}}.',
      '',
      'Invoice: {{{INVOICE_NUMBER}}}',
      'Plan: {{{PLAN_NAME}}}',
      'Paid for: {{{PERIOD}}}',
      'Amount: {{{AMOUNT}}}',
      'Reference: {{{REFERENCE}}}',
      '',
      'Invoices: {{{BILLING_URL}}}',
      '',
      '{{{SUPPORT_LINE}}}',
    ].join('\n'),
  },
};

// Example values (the console's test send, and the docs).
const SAMPLE = {
  OWNER_NAME: 'Sarah Achieng',
  RESTAURANT_NAME: 'Kampala Grill House',
  SUPPORT_LINE: 'Questions? Contact Relay support: 0700 123456.',
  RESTAURANT_CODE: 'kampala-grill-house',
  USERNAME: 'sarah',
  PLAN_NAME: 'Basic',
  TRIAL_DAYS: '14',
  TRIAL_ENDS: '15 October 2026',
  SIGN_IN_URL: 'https://relay.example/r/kampala-grill-house',
  RESET_URL: 'https://relay.example/?reset=example',
  EXPIRES_IN: 'an hour',
  HEADLINE: 'Your free trial ends in 3 days',
  DAYS_LEFT: '3',
  AMOUNT: 'UGX 100,000',
  ANNUAL_AMOUNT: 'UGX 1,000,000',
  DUE_DATE: '15 October 2026',
  INVOICE_NUMBER: 'INV-KAMPALA-GRILL-HOUSE-20261015',
  BILLING_URL: 'https://relay.example/admin/site/billing',
  CLOSES_ON: '22 October 2026',
  DAYS_TO_CLOSE: '7',
  PERIOD: '1 month',
  PAID_UNTIL: '15 November 2026',
  REFERENCE: 'MTN 1234567890',
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Fills in a template string; missing variables become empty.
function fill(template, variables, escape = (value) => value) {
  return template.replace(/\{\{\{\s*([A-Z0-9_]+)\s*\}\}\}/g, (_, name) =>
    escape(variables[name] ?? ''),
  );
}

// { subject, text, html } of a kind with these variables (Relay's own copy).
function render(kind, variables) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown email kind ${kind}`);
  // Only the variables the kind declares, as strings (what a service gets too).
  const vars = Object.fromEntries(
    spec.variables.map((name) => [name, String(variables[name] ?? '')]),
  );
  return {
    subject: fill(spec.subject, vars),
    text: fill(spec.text, vars),
    html: fill(spec.html, vars, escapeHtml),
    variables: vars,
  };
}

// The same HTML for Brevo, whose templates write {{ params.NAME }}.
const forBrevo = (template) =>
  template.replace(/\{\{\{\s*([A-Z0-9_]+)\s*\}\}\}/g, (_, name) => `{{ params.${name} }}`);

// Values as the emails write them: "15 October 2026" (Kampala time) and
// "UGX 100,000".
const dateText = (date, timeZone = process.env.RELAY_EMAIL_TZ || 'Africa/Kampala') =>
  date
    ? new Date(date).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone,
      })
    : '';
const moneyText = (amount, currency) =>
  `${currency || ''} ${Math.round(Number(amount) || 0).toLocaleString('en-US')}`.trim();

module.exports = { KINDS, SAMPLE, render, fill, forBrevo, dateText, moneyText };
