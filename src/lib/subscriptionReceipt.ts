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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relay receipt RLY-${escape(
    payment.id,
  )}</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#0b1633;max-width:520px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:#5f687c}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #e5e9f1;vertical-align:top}
td:first-child{color:#5f687c;width:40%}.total td{font-size:18px;font-weight:700;border-bottom:0;padding-top:16px}
small{display:block;margin-top:24px;color:#5f687c}@media print{body{margin:0 auto}}
</style></head><body><h1>Receipt</h1><p>Relay · software by Embiro Concepts</p><table>${rows
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
