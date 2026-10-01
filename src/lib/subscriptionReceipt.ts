import embiroLogo from '../assets/embiro-logo-small.webp';
import { formatDate, formatMoney } from './format';

// Relay Hosted: invoices and receipts for the subscription, opened in a new
// window to print or save as PDF (the browser's print dialog). One layout
// for both: title and Relay's mark, the numbers and dates, who it is from and
// who it is billed to, the amount line, the item and totals, and on a receipt
// the payment history.

export type ReceiptPayment = {
  id: string;
  amount: number;
  currency: string;
  months: number;
  // An upgrade (months 0) and the plan paid for, when known.
  kind?: 'period' | 'upgrade';
  planName?: string;
  method: 'iotec' | 'manual';
  payer: string;
  reference: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  // A first payment with a sign-up code: the price before it.
  listAmount?: number | null;
  discount?: number;
  discountCode?: string;
};

export type InvoiceDoc = {
  number: string;
  status: 'paid' | 'due' | 'overdue';
  issuedAt: string;
  dueAt: string | null;
  months: number;
  // An upgrade (months 0) and the plan paid for, when known.
  kind?: 'period' | 'upgrade';
  planName?: string;
  amount: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  listAmount?: number | null;
  discount?: number;
  discountCode?: string;
};

// What the documents know about the restaurant (its summary).
export type BilledRestaurant = {
  name: string;
  code: string;
  ownerName?: string;
  ownerEmail?: string;
  billingPhone?: string;
  planName?: string;
  billingFrom?: string;
  supportContact?: string;
};

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
  );

// The number of a paid payment's invoice and receipt.
export const invoiceNumberOf = (code: string, paymentId: string) =>
  `INV-${code.toUpperCase()}-${paymentId}`;
export const receiptNumberOf = (paymentId: string) => `RLY-${paymentId}`;

type Doc = {
  kind: 'invoice' | 'receipt';
  number: string;
  receiptNumber?: string;
  status: 'paid' | 'due' | 'overdue';
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  months: number;
  // An upgrade (months 0) and the plan paid for, when known.
  payKind?: 'period' | 'upgrade';
  planName?: string;
  amount: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidWith?: string;
  discount?: number;
  discountCode?: string;
};

const STYLE = `
@page{size:A4;margin:16mm}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#0b1633;font:14px/1.55 Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:780px;margin:0 auto;padding:40px 32px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
h1{font-size:34px;line-height:1.1;margin:0 0 22px;letter-spacing:-.02em}
.mark{display:flex;align-items:center;gap:10px;font-weight:800;font-size:22px;letter-spacing:-.01em}
.mark img{width:40px;height:40px}
.meta{border-collapse:collapse;margin-bottom:28px}
.meta td{padding:1px 0;vertical-align:top}.meta td:first-child{font-weight:600;padding-right:16px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:32px}
.parties h3{font-size:14px;margin:0 0 6px}.parties p{margin:0}
.tag{display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:#eef1f7;color:#3a4560;font-weight:500;font-size:13px}
h2{font-size:22px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}
.pay{display:inline-block;margin:0 0 4px;color:#3d5cf5;font-weight:600}
.status{display:inline-block;margin-left:10px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.06em;vertical-align:middle}
.status.paid{background:#dff5e6;color:#17653a}.status.due{background:#fff3d6;color:#8a5a00}.status.overdue{background:#fde2e2;color:#a11a1a}
.items{width:100%;border-collapse:collapse;margin-top:32px}
.items th{font-size:12px;font-weight:500;color:#3a4560;text-align:left;padding:0 0 8px;border-bottom:1.5px solid #0b1633}
.items td{padding:12px 0;vertical-align:top}
.items .num{text-align:right;white-space:nowrap;padding-left:24px}
.items .sub{color:#5b6478}
.totals{width:50%;margin-left:50%;border-collapse:collapse;margin-top:12px}
.totals td{padding:5px 0;border-top:1px solid #e3e6ee}.totals td:last-child{text-align:right}
.totals tr.strong td{font-weight:700}
h4{font-size:20px;margin:40px 0 0}
.note{margin-top:36px;color:#5b6478;font-size:13px}
.credit{display:flex;align-items:center;gap:6px;margin-top:28px;font-size:11px;color:#5b6478}
.credit img{height:14px;width:auto}
@media print{.page{padding:0}}
@media (max-width:560px){.parties{grid-template-columns:1fr}.totals{width:100%;margin-left:0}}
`;

function render(doc: Doc, restaurant: BilledRestaurant, timeZone: string) {
  const day = (value: string | null) => formatDate(value, timeZone, { dateStyle: 'long' });
  const money = (amount: number) => formatMoney(amount, doc.currency);
  const paid = doc.status === 'paid';
  const isReceipt = doc.kind === 'receipt';

  const metaRows: [string, string][] = [
    ['Invoice number', doc.number],
    ...(isReceipt
      ? ([
          ['Receipt number', doc.receiptNumber || ''],
          ['Date paid', day(doc.paidAt)],
        ] as [string, string][])
      : ([
          ['Date of issue', day(doc.issuedAt)],
          ['Date due', paid ? day(doc.paidAt || doc.issuedAt) : day(doc.dueAt)],
        ] as [string, string][])),
  ];

  // From: the platform's business details (console → Platform settings).
  const fromLines = (restaurant.billingFrom || 'Relay').split('\n').filter(Boolean);
  if (restaurant.supportContact && !fromLines.includes(restaurant.supportContact))
    fromLines.push(restaurant.supportContact);
  const [fromName, ...fromRest] = fromLines;
  const billTo = [restaurant.ownerName, restaurant.billingPhone, restaurant.ownerEmail].filter(
    Boolean,
  ) as string[];

  const upgrade = doc.payKind === 'upgrade';
  const year = doc.months === 12;
  const planName = doc.planName || restaurant.planName;
  const plan = planName ? `Relay ${planName} plan` : 'Relay subscription';
  const description = upgrade
    ? `Upgrade to ${plan}, for the days left`
    : `${plan}${year ? ', paid yearly' : ''}`;
  const qty = year || upgrade ? '1' : String(doc.months);
  // The item at its full price; a sign-up code comes off in the totals.
  const discount = doc.discount || 0;
  const full = doc.amount + discount;
  const unit = year || upgrade ? full : Math.round(full / Math.max(1, doc.months));
  const period =
    doc.periodStart && doc.periodEnd
      ? `${formatDate(doc.periodStart, timeZone, { dateStyle: 'medium' })} – ${formatDate(
          doc.periodEnd,
          timeZone,
          { dateStyle: 'medium' },
        )}`
      : '';
  const unitLabel = upgrade ? 'the difference' : year ? 'a year' : 'a month';

  const statusLabel = paid ? 'PAID' : doc.status === 'overdue' ? 'OVERDUE' : 'DUE';
  const headline = paid
    ? `${money(doc.amount)} paid on ${day(doc.paidAt)}`
    : `${money(doc.amount)} due ${day(doc.dueAt)}`;
  const payUrl = new URL('/admin/site/billing', window.location.href).href;

  const relayLogo = new URL('/icons/favicon.svg', window.location.href).href;
  const embiro = new URL(embiroLogo, window.location.href).href;
  const title = `${isReceipt ? 'Receipt' : 'Invoice'} ${isReceipt ? doc.receiptNumber : doc.number}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
    title,
  )}</title><style>${STYLE}</style></head><body><div class="page">
<div class="top"><div><h1>${isReceipt ? 'Receipt' : 'Invoice'}</h1>
<table class="meta">${metaRows
    .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${escape(v)}</td></tr>`)
    .join('')}</table></div>
<div class="mark"><img src="${relayLogo}" alt="">Relay</div></div>
<div class="parties">
<div><h3>${escape(fromName)}</h3><p>${fromRest.map(escape).join('<br>')}</p></div>
<div><h3>Bill to</h3><p><strong>${escape(restaurant.name)}</strong><span class="tag">@${escape(
    restaurant.code,
  )}</span><br>${billTo.map(escape).join('<br>')}</p></div>
</div>
<h2>${escape(headline)}${isReceipt ? '' : `<span class="status ${doc.status}">${statusLabel}</span>`}</h2>
${paid ? '' : `<a class="pay" href="${escape(payUrl)}">Pay online</a>`}
<table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
<tbody><tr><td>${escape(description)}${period ? `<div class="sub">${escape(period)}</div>` : ''}</td>
<td class="num">${qty}</td><td class="num">${escape(money(unit))}<div class="sub">${unitLabel}</div></td><td class="num">${escape(
    money(full),
  )}</td></tr></tbody></table>
<table class="totals"><tr><td>Subtotal</td><td>${escape(money(full))}</td></tr>${
    discount
      ? `<tr><td>Discount${doc.discountCode ? ` (${escape(doc.discountCode)})` : ''}</td><td>−${escape(money(discount))}</td></tr>`
      : ''
  }
<tr><td>Total</td><td>${escape(money(doc.amount))}</td></tr>
<tr class="strong"><td>${paid ? 'Amount paid' : 'Amount due'}</td><td>${escape(
    `${money(doc.amount)}`,
  )}</td></tr></table>
${
  isReceipt
    ? `<h4>Payment history</h4><table class="items"><thead><tr><th>Payment method</th><th>Date</th><th class="num">Amount paid</th><th class="num">Receipt number</th></tr></thead>
<tbody><tr><td>${escape(doc.paidWith || '')}</td><td>${escape(day(doc.paidAt))}</td><td class="num">${escape(
        money(doc.amount),
      )}</td><td class="num">${escape(doc.receiptNumber || '')}</td></tr></tbody></table>`
    : ''
}
<p class="note">${
    paid
      ? 'Thank you for using Relay.'
      : `Pay in the app: Admin → Billing → Pay, with MTN MoMo or Airtel Money.${
          restaurant.supportContact ? ` Questions: ${escape(restaurant.supportContact)}.` : ''
        }`
  }</p>
<p class="credit">Powered by <img src="${embiro}" alt="Embiro"></p>
</div><script>window.onload=()=>window.print()</script></body></html>`;
}

function open(html: string) {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

const paidWith = (payment: ReceiptPayment) =>
  payment.method === 'manual'
    ? `Received by Relay${payment.reference ? ` (${payment.reference})` : ''}`
    : `Mobile money ${payment.payer}${payment.reference ? ` · ${payment.reference}` : ''}`;

// The receipt for a paid subscription payment.
export function printSubscriptionReceipt(
  payment: ReceiptPayment,
  restaurant: BilledRestaurant,
  timeZone: string,
) {
  return open(
    render(
      {
        kind: 'receipt',
        number: invoiceNumberOf(restaurant.code, payment.id),
        receiptNumber: receiptNumberOf(payment.id),
        status: 'paid',
        issuedAt: payment.paidAt,
        dueAt: null,
        paidAt: payment.paidAt,
        months: payment.months,
        payKind: payment.kind,
        planName: payment.planName,
        amount: payment.amount,
        discount: payment.discount || 0,
        discountCode: payment.discountCode || '',
        currency: payment.currency,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
        paidWith: paidWith(payment),
      },
      restaurant,
      timeZone,
    ),
  );
}

// An invoice for one subscription period, paid or still to pay.
export function printSubscriptionInvoice(
  invoice: InvoiceDoc,
  restaurant: BilledRestaurant,
  timeZone: string,
) {
  return open(
    render(
      {
        kind: 'invoice',
        number: invoice.number,
        status: invoice.status,
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        paidAt: invoice.status === 'paid' ? invoice.issuedAt : null,
        months: invoice.months,
        payKind: invoice.kind,
        planName: invoice.planName,
        amount: invoice.amount,
        discount: invoice.discount || 0,
        discountCode: invoice.discountCode || '',
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      },
      restaurant,
      timeZone,
    ),
  );
}
