import { useCallback, useState } from 'react';
import Parse from '../parse';
import { useConfig } from './session';
import { formatDate, formatMoney } from './format';

// Printed kitchen tickets and customer receipts. The browser prints to any
// printer, including 58 mm / 80 mm thermal receipt printers (set the width in
// Settings, and choose the receipt printer in the print dialog once; most
// browsers remember it). Each print renders in its own hidden frame so the
// app's styles never leak onto the paper.

export type PrintKind = 'kitchen' | 'receipt';

type Receipt = {
  restaurant: string;
  header: string;
  footer: string;
  width: number;
  code: string;
  type: string;
  status: string;
  table: string;
  channel: string;
  placedAt: string;
  customer: string;
  phone: string;
  address: string;
  notes: string;
  rider: string;
  staff: string;
  lines: {
    name: string;
    qty: number;
    price: number;
    total: number;
    notes: string;
    accompaniments: string[];
  }[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  payment: {
    method: string;
    provider: string;
    reference: string;
    state: 'paid' | 'unpaid' | 'on_delivery' | 'checking';
    paidAt: string | null;
  };
};

const TYPE: Record<string, string> = { delivery: 'DELIVERY', eat_in: 'EAT IN', pickup: 'PICK UP' };
const PROVIDER: Record<string, string> = { mtn: 'MTN MoMo', airtel: 'Airtel Money' };

const escape = (text: unknown) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const lines = (text: string) => escape(text).replace(/\n/g, '<br>');

function styles(width: number) {
  // A little narrower than the paper: thermal heads do not print to the edge.
  const body = width === 58 ? 48 : 72;
  return `
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: ${body}mm; margin: 0 auto; padding: 3mm 0 6mm;
      font: ${width === 58 ? 11 : 12}px/1.35 'Courier New', ui-monospace, monospace; }
    h1 { font-size: 1.35em; margin: 0 0 1mm; text-align: center; }
    .big { font-size: 1.6em; font-weight: 700; text-align: center; margin: 1mm 0; }
    .center { text-align: center; }
    .muted { font-size: 0.9em; }
    hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
    table { width: 100%; border-collapse: collapse; }
    td { vertical-align: top; padding: 0.4mm 0; }
    td.num { text-align: right; white-space: nowrap; padding-left: 2mm; }
    .qty { width: 1%; white-space: nowrap; padding-right: 2mm; font-weight: 700; }
    .note { font-weight: 700; }
    .sub { font-size: 0.9em; padding-left: 2mm; }
    .total td { font-weight: 700; font-size: 1.15em; padding-top: 1mm; }
    .stamp { border: 2px solid #000; text-align: center; font-weight: 700; padding: 1mm; margin: 2mm 0; }
  `;
}

function kitchenTicket(r: Receipt, timezone: string) {
  const when = formatDate(r.placedAt, timezone, { timeStyle: 'short' });
  const where = [TYPE[r.type] || r.type, r.table].filter(Boolean).join(' · ');
  return `
    <div class="big">${escape(r.code.split('-').pop())}</div>
    <div class="center"><b>${escape(where)}</b> · ${escape(when)}</div>
    <div class="center muted">${escape(r.code)}</div>
    <hr>
    ${r.customer ? `<div><b>${escape(r.customer)}</b></div>` : ''}
    ${r.rider ? `<div class="muted">Rider: ${escape(r.rider)}</div>` : ''}
    <hr>
    <table>
      ${r.lines
        .map(
          (line) => `
        <tr><td class="qty">${line.qty}×</td><td><b>${escape(line.name)}</b>
          ${line.accompaniments.length ? `<div class="sub">+ ${escape(line.accompaniments.join(', '))}</div>` : ''}
          ${line.notes ? `<div class="sub note">! ${escape(line.notes)}</div>` : ''}
        </td></tr>`,
        )
        .join('')}
    </table>
    ${r.notes && r.notes !== r.table ? `<hr><div class="note">${escape(r.notes)}</div>` : ''}
    <hr>
    <div class="center muted">Printed ${escape(formatDate(new Date(), timezone, { timeStyle: 'short' }))}</div>`;
}

function customerReceipt(r: Receipt, timezone: string, symbol: string) {
  const money = (n: number) => escape(formatMoney(n, symbol));
  const when = formatDate(r.placedAt, timezone, { dateStyle: 'medium', timeStyle: 'short' });
  const where = [TYPE[r.type] || r.type, r.table].filter(Boolean).join(' · ');
  const method =
    r.payment.method === 'cash'
      ? 'Cash'
      : `${PROVIDER[r.payment.provider] || 'Mobile money'}${
          r.payment.reference ? ` · ${escape(r.payment.reference)}` : ''
        }`;
  const payment =
    r.payment.state === 'paid'
      ? `PAID · ${method}`
      : r.payment.state === 'unpaid'
        ? 'NOT PAID'
        : r.payment.state === 'on_delivery'
          ? 'PAY ON DELIVERY (cash)'
          : `PAYMENT BEING CHECKED · ${method}`;
  return `
    <h1>${escape(r.restaurant)}</h1>
    ${r.header ? `<div class="center muted">${lines(r.header)}</div>` : ''}
    <hr>
    <div><b>${escape(r.code)}</b></div>
    <div>${escape(when)}</div>
    <div>${escape(where)}</div>
    ${r.customer ? `<div>${escape(r.customer)}${r.phone ? ` · ${escape(r.phone)}` : ''}</div>` : ''}
    ${r.address ? `<div class="muted">${escape(r.address)}</div>` : ''}
    <hr>
    <table>
      ${r.lines
        .map(
          (line) => `
        <tr><td class="qty">${line.qty}×</td><td>${escape(line.name)}
          ${line.accompaniments.length ? `<div class="sub">+ ${escape(line.accompaniments.join(', '))}</div>` : ''}
        </td><td class="num">${money(line.total)}</td></tr>`,
        )
        .join('')}
    </table>
    <hr>
    <table>
      <tr><td>Subtotal</td><td class="num">${money(r.subtotal)}</td></tr>
      ${r.deliveryFee ? `<tr><td>Delivery</td><td class="num">${money(r.deliveryFee)}</td></tr>` : ''}
      <tr class="total"><td>TOTAL</td><td class="num">${money(r.total)}</td></tr>
    </table>
    <div class="stamp">${payment}</div>
    ${r.staff ? `<div class="muted">Served by ${escape(r.staff)}</div>` : ''}
    ${r.footer ? `<hr><div class="center">${lines(r.footer)}</div>` : ''}`;
}

// Prints an order's kitchen ticket or customer receipt.
export async function printOrder(
  orderId: string,
  kind: PrintKind,
  { timezone, currencySymbol }: { timezone: string; currencySymbol: string },
) {
  const receipt: Receipt = await Parse.Cloud.run('getReceipt', { orderId });
  const body =
    kind === 'kitchen'
      ? kitchenTicket(receipt, timezone)
      : customerReceipt(receipt, timezone, currencySymbol);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(receipt.code)}</title><style>${styles(
      receipt.width,
    )}</style></head><body>${body}</body></html>`,
  );
  doc.close();
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  // Printing is synchronous in most browsers; remove the frame afterwards.
  window.setTimeout(() => frame.remove(), 60000);
  return receipt;
}

// For screens: print an order, with an error message if it fails.
export function usePrint() {
  const { timezone, currencySymbol } = useConfig();
  const [error, setError] = useState('');
  const print = useCallback(
    async (orderId: string, kind: PrintKind) => {
      setError('');
      try {
        await printOrder(orderId, kind, { timezone, currencySymbol });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not print');
      }
    },
    [timezone, currencySymbol],
  );
  return { print, printError: error };
}

// Test hook: the HTML that would be printed.
export const receiptHtml = { kitchenTicket, customerReceipt };
