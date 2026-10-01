// Printed fliers and table cards with the restaurant's QR code for its online
// menu (Admin → Online orders). Pure HTML + CSS for the print frame
// (lib/print.ts printDocument), so they print the same in every browser.

export type FlierSize = 'a4' | 'a5' | 'cards';

export type Flier = {
  size: FlierSize;
  restaurant: string;
  logo: string;
  qr: string; // data: URL of the QR code
  link: string;
  headline: string;
  subline: string;
  modes: string; // e.g. "Pick-up · Delivery"
  payments: string; // e.g. "Cash · MTN MoMo · Airtel Money"
  note: string;
  ink: string;
  accent: string;
};

const escape = (text: string) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const colour = (value: string, fallback: string) =>
  /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

// One flier (or card): logo, name, headline, the QR code and the link.
function card(f: Flier) {
  const initial = escape(f.restaurant.charAt(0) || 'R');
  return `<section class="flier">
  <div class="band"></div>
  <div class="body">
    ${f.logo ? `<img class="logo" src="${escape(f.logo)}" alt="">` : `<div class="logo initial">${initial}</div>`}
    <h1>${escape(f.restaurant)}</h1>
    <p class="headline">${escape(f.headline)}</p>
    <p class="subline">${escape(f.subline)}</p>
    <div class="qr"><img src="${escape(f.qr)}" alt="QR code"></div>
    <p class="link">${escape(f.link.replace(/^https?:\/\//, ''))}</p>
    ${f.modes ? `<p class="chips">${escape(f.modes)}</p>` : ''}
    ${f.payments ? `<p class="pay">${escape(f.payments)}</p>` : ''}
    ${f.note ? `<p class="note">${escape(f.note)}</p>` : ''}
  </div>
  <p class="by">Ordering by RelayEats</p>
</section>`;
}

export function flierHtml(f: Flier) {
  const copies = f.size === 'cards' ? 4 : 1;
  return `<main class="sheet ${f.size}">${Array.from({ length: copies }, () => card(f)).join('')}</main>`;
}

export function flierCss(f: Pick<Flier, 'size' | 'ink' | 'accent'>) {
  const ink = colour(f.ink, '#0b1633');
  const accent = colour(f.accent, '#f14c1d');
  const page = f.size === 'a5' ? 'A5' : 'A4';
  // Sizes in mm so the QR prints big enough to scan from arm's length.
  const s =
    f.size === 'a4'
      ? { name: 13, head: 9, sub: 5, qr: 95, logo: 30, small: 4.2, pad: 18 }
      : f.size === 'a5'
        ? { name: 9.5, head: 6.5, sub: 3.8, qr: 70, logo: 22, small: 3.2, pad: 12 }
        : { name: 6, head: 4.4, sub: 2.6, qr: 44, logo: 13, small: 2.3, pad: 6 };
  return `
@page { size: ${page} portrait; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${ink};
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: ${page === 'A5' ? 148 : 210}mm; height: ${page === 'A5' ? 210 : 297}mm; display: grid; }
.sheet.cards { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.flier { position: relative; display: flex; flex-direction: column; overflow: hidden;
  border: ${f.size === 'cards' ? `0.3mm dashed #c9ccd6` : '0'}; }
.band { height: ${s.pad * 0.9}mm; background: ${accent}; }
.body { flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: ${s.pad * 0.8}mm ${s.pad}mm 0; }
.logo { width: ${s.logo}mm; height: ${s.logo}mm; border-radius: 22%; object-fit: cover; }
.logo.initial { background: ${ink}; color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: ${s.logo * 0.55}mm; font-weight: 800; }
h1 { font-size: ${s.name}mm; line-height: 1.1; margin: ${s.pad * 0.35}mm 0 0; font-weight: 800; letter-spacing: -0.02em; }
.headline { font-size: ${s.head}mm; font-weight: 800; color: ${accent}; margin: ${s.pad * 0.3}mm 0 0; }
.subline { font-size: ${s.sub}mm; margin: ${s.pad * 0.15}mm 0 0; color: #4b5468; }
.qr { margin: ${s.pad * 0.45}mm 0 0; padding: ${s.pad * 0.25}mm; border: 0.6mm solid ${ink}; border-radius: ${s.pad * 0.3}mm; background: #fff; }
.qr img { display: block; width: ${s.qr}mm; height: ${s.qr}mm; image-rendering: pixelated; }
.link { font-size: ${s.small * 1.15}mm; font-weight: 700; margin: ${s.pad * 0.3}mm 0 0; word-break: break-all; }
.chips { font-size: ${s.small}mm; font-weight: 700; margin: ${s.pad * 0.25}mm 0 0; }
.pay { font-size: ${s.small}mm; margin: ${s.pad * 0.1}mm 0 0; color: #4b5468; }
.note { font-size: ${s.small}mm; margin: ${s.pad * 0.2}mm 0 0; color: #4b5468; }
.by { font-size: ${s.small * 0.8}mm; color: #8a91a3; text-align: center; margin: 0 0 ${s.pad * 0.5}mm; }
`;
}
