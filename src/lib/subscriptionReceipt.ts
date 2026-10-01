import embiroLogo from '../assets/embiro-logo-small.webp';
import { formatDate, formatMoney } from './format';

// Relay Hosted: a receipt for a paid subscription payment, opened in a new
// window to print or save as PDF (the browser's print dialog).

export type ReceiptPayment = {
  id: string;
  amount: number;
  currency: string;
  months: number;
  method: 'iotec' | 'manual';
  payer: string;
  reference: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
};

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
  );

export function printSubscriptionReceipt(
  payment: ReceiptPayment,
  restaurant: { name: string; code: string },
  timeZone: string,
) {
  const day = (value: string | null) => formatDate(value, timeZone, { dateStyle: 'long' });
  const rows: [string, string][] = [
    ['Receipt no.', `RLY-${payment.id}`],
    ['Paid on', day(payment.paidAt)],
    ['Restaurant', `${restaurant.name} (${restaurant.code})`],
    ['For', `Relay subscription, ${payment.months} month${payment.months === 1 ? '' : 's'}`],
    ['Period', `${day(payment.periodStart)} to ${day(payment.periodEnd)}`],
    [
      'Paid by',
      payment.method === 'manual' ? 'Payment received by Relay' : `Mobile money ${payment.payer}`,
    ],
    ['Reference', payment.reference || '—'],
  ];
  // Absolute addresses: the receipt opens in a new, blank window.
  const relayLogo = new URL('/icons/favicon.svg', window.location.href).href;
  const embiro = new URL(embiroLogo, window.location.href).href;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relay receipt RLY-${escape(
    payment.id,
  )}</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#0b1633;max-width:520px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:#5f687c}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #e5e9f1;vertical-align:top}
td:first-child{color:#5f687c;width:40%}.total td{font-size:18px;font-weight:700;border-bottom:0;padding-top:16px}
small{display:block;margin-top:24px;color:#5f687c}@media print{body{margin:0 auto}}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}.brand img{width:40px;height:40px}
.brand b{font-size:22px}.credit{display:flex;align-items:center;gap:6px;font-size:11px;color:#5f687c;margin:0 0 24px}
.credit img{height:15px;width:auto}
</style></head><body><div class="brand"><img src="${relayLogo}" alt=""><b>Relay</b></div>
<p class="credit">Powered by <img src="${embiro}" alt="Embiro"></p><h1>Receipt</h1><p>Subscription payment</p><table>${rows
    .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${escape(v)}</td></tr>`)
    .join('')}<tr class="total"><td>Amount paid</td><td>${escape(
    formatMoney(payment.amount, payment.currency),
  )}</td></tr></table><small>Thank you for using Relay.</small><script>window.onload=()=>window.print()</script></body></html>`;
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

export type InvoiceDoc = {
  number: string;
  status: 'paid' | 'due' | 'overdue';
  issuedAt: string;
  dueAt: string | null;
  months: number;
  amount: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
};

// An invoice for one subscription period, paid or still to pay, opened in a
// new window to print or save as PDF.
export function printSubscriptionInvoice(
  invoice: InvoiceDoc,
  restaurant: { name: string; code: string; ownerEmail?: string },
  timeZone: string,
  supportContact = '',
) {
  const day = (value: string | null) => formatDate(value, timeZone, { dateStyle: 'long' });
  const what =
    invoice.months === 12
      ? 'Relay subscription, 1 year'
      : `Relay subscription, ${invoice.months} month${invoice.months === 1 ? '' : 's'}`;
  const rows: [string, string][] = [
    ['Invoice no.', invoice.number],
    ['Issued', day(invoice.issuedAt)],
    ...(invoice.dueAt ? ([['Due', day(invoice.dueAt)]] as [string, string][]) : []),
    ['Billed to', `${restaurant.name} (${restaurant.code})`],
    ...(restaurant.ownerEmail ? ([['Email', restaurant.ownerEmail]] as [string, string][]) : []),
    ['Description', what],
    ['Period', `${day(invoice.periodStart)} to ${day(invoice.periodEnd)}`],
  ];
  const stamp =
    invoice.status === 'paid'
      ? '<div class="stamp paid">PAID</div>'
      : `<div class="stamp due">${invoice.status === 'overdue' ? 'OVERDUE' : 'DUE'}</div>`;
  const how =
    invoice.status === 'paid'
      ? 'Thank you for using Relay.'
      : `Pay from the app: Admin → Billing → Pay, with MTN MoMo or Airtel Money.${
          supportContact ? ` Questions: ${escape(supportContact)}.` : ''
        }`;
  const relayLogo = new URL('/icons/favicon.svg', window.location.href).href;
  const embiro = new URL(embiroLogo, window.location.href).href;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relay invoice ${escape(
    invoice.number,
  )}</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#0b1633;max-width:560px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:#5f687c}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #e5e9f1;vertical-align:top}
td:first-child{color:#5f687c;width:40%}.total td{font-size:18px;font-weight:700;border-bottom:0;padding-top:16px}
small{display:block;margin-top:24px;color:#5f687c}@media print{body{margin:0 auto}}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}.brand img{width:40px;height:40px}
.brand b{font-size:22px}.credit{display:flex;align-items:center;gap:6px;font-size:11px;color:#5f687c;margin:0 0 24px}
.credit img{height:15px;width:auto}.head{display:flex;justify-content:space-between;align-items:flex-start}
.stamp{border:2px solid;border-radius:8px;padding:6px 12px;font-weight:800;letter-spacing:.1em}
.stamp.paid{color:#1f7a4d}.stamp.due{color:#c2410c}
</style></head><body><div class="brand"><img src="${relayLogo}" alt=""><b>Relay</b></div>
<p class="credit">Powered by <img src="${embiro}" alt="Embiro"></p><div class="head"><div><h1>Invoice</h1><p>Subscription</p></div>${stamp}</div><table>${rows
    .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${escape(v)}</td></tr>`)
    .join('')}<tr class="total"><td>${
    invoice.status === 'paid' ? 'Amount paid' : 'Amount due'
  }</td><td>${escape(formatMoney(invoice.amount, invoice.currency))}</td></tr></table><small>${how}</small><script>window.onload=()=>window.print()</script></body></html>`;
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}
