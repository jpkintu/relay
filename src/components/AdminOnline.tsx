import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, ExternalLink, Printer, Share2 } from 'lucide-react';
import { useAdminRun } from '../lib/adminRun';
import { useSession } from '../lib/session';
import { printDocument } from '../lib/print';
import { flierCss, flierHtml, type FlierSize } from '../lib/flier';

// Admin → Online orders: switch the public menu on, choose what customers
// can do there, and share it: the link, its QR code, and printed fliers or
// table cards with the QR code (online.js, OnlineOrder.tsx).

type Settings = {
  onlineOrders: boolean;
  onlineOpen: boolean;
  onlinePickup: boolean;
  onlineDelivery: boolean;
  onlineCash: boolean;
  onlineMobileMoney: boolean;
  mobileMoneyReady: boolean;
  onlineNote: string;
};

// The public menu's address: the restaurant's own (RelayEats Hosted:
// <code>.<domain>/order, or …/order/<code>), else this app's /order.
function useOrderLink() {
  const { appInfo } = useSession();
  return useMemo(() => {
    const info = appInfo as {
      restaurant?: { code?: string };
      platform?: { restaurantDomain?: string };
    };
    const code = info.restaurant?.code || '';
    const domain = info.platform?.restaurantDomain || '';
    if (code && domain) return `https://${code}.${domain}/order`;
    if (code) return `${window.location.origin}/order/${code}`;
    return `${window.location.origin}/order`;
  }, [appInfo]);
}

export function AdminOnline() {
  const adminRun = useAdminRun();
  const { config } = useSession();
  const link = useOrderLink();
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [qr, setQr] = useState('');
  const [size, setSize] = useState<FlierSize>('a4');
  const [headline, setHeadline] = useState('Order online');
  const [subline, setSubline] = useState('Scan to see our live menu and order');

  useEffect(() => {
    adminRun<Settings>('adminGetOnlineOrdering')
      .then(setForm)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  }, [adminRun]);
  useEffect(() => {
    QRCode.toDataURL(link, {
      margin: 1,
      width: 900,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1633', light: '#ffffff' },
    })
      .then(setQr)
      .catch(() => setQr(''));
  }, [link]);

  const save = async (patch: Partial<Settings>) => {
    if (!form) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const next = await adminRun<Settings>('adminSaveOnlineOrdering', { ...form, ...patch });
      setForm(next);
      setDone('Saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const modes = form
    ? [form.onlinePickup && 'Pick-up', form.onlineDelivery && 'Delivery']
        .filter(Boolean)
        .join(' · ')
    : '';
  const payments = form
    ? [
        form.onlineCash && 'Cash on pick-up or delivery',
        form.onlineMobileMoney &&
          form.mobileMoneyReady &&
          (config.mobileMoney || []).map((a) => a.label).join(' · '),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const flier = {
    size,
    restaurant: config.restaurantName,
    logo: config.restaurantLogo || '',
    qr,
    link,
    headline,
    subline,
    modes,
    payments,
    note: form?.onlineNote || '',
    ink: config.theme?.ink || '',
    accent: config.theme?.accent || '',
  };
  const preview = `<!doctype html><html><head><meta charset="utf-8"><style>${flierCss(flier)} body{transform-origin:top left}</style></head><body>${flierHtml(flier)}</body></html>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setDone('Link copied.');
    } catch {
      setError('Copy the link from the box.');
    }
  };
  const share = async () => {
    try {
      await navigator.share({
        title: config.restaurantName,
        text: `Order from ${config.restaurantName} online:`,
        url: link,
      });
    } catch {
      // Closed the share sheet.
    }
  };

  if (!form)
    return error ? (
      <p className="ops-error">{error}</p>
    ) : (
      <p className="section-loading">Loading…</p>
    );

  return (
    <div className="data-page online-admin">
      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>Online orders</h2>
            <p className="muted">
              Customers open your menu from a link or a QR code, order for pick-up or delivery
              without signing in, and pay cash or by mobile money. Orders arrive on the kitchen
              board as Incoming, marked Online.
            </p>
          </div>
        </div>
        <label className="setup-checkbox">
          <input
            type="checkbox"
            checked={form.onlineOrders}
            disabled={busy}
            onChange={(e) => void save({ onlineOrders: e.target.checked })}
          />{' '}
          Take orders online
        </label>
        {form.onlineOrders && (
          <>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={form.onlineOpen}
                disabled={busy}
                onChange={(e) => void save({ onlineOpen: e.target.checked })}
              />{' '}
              Taking orders now{' '}
              <small className="muted">
                (cashiers can pause it from the kitchen board when it is busy)
              </small>
            </label>
            <div className="online-options">
              <fieldset>
                <legend>Customers can choose</legend>
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={form.onlinePickup}
                    onChange={(e) => setForm({ ...form, onlinePickup: e.target.checked })}
                  />{' '}
                  Pick-up
                </label>
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={form.onlineDelivery}
                    onChange={(e) => setForm({ ...form, onlineDelivery: e.target.checked })}
                  />{' '}
                  Delivery <small className="muted">(the delivery fee in Settings applies)</small>
                </label>
              </fieldset>
              <fieldset>
                <legend>They pay</legend>
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={form.onlineCash}
                    onChange={(e) => setForm({ ...form, onlineCash: e.target.checked })}
                  />{' '}
                  Cash on pick-up or delivery
                </label>
                <label className="setup-checkbox">
                  <input
                    type="checkbox"
                    checked={form.onlineMobileMoney}
                    disabled={!form.mobileMoneyReady}
                    onChange={(e) => setForm({ ...form, onlineMobileMoney: e.target.checked })}
                  />{' '}
                  Mobile money when ordering{' '}
                  {!form.mobileMoneyReady && (
                    <small className="muted">(add your merchant codes in Settings first)</small>
                  )}
                </label>
              </fieldset>
            </div>
            <label className="setup-field">
              A line for customers (optional)
              <input
                value={form.onlineNote}
                maxLength={200}
                onChange={(e) => setForm({ ...form, onlineNote: e.target.value })}
                placeholder="e.g. Delivery within Kampala, about 45 minutes"
              />
            </label>
            <div className="platform-actions">
              <button className="primary-button" disabled={busy} onClick={() => void save({})}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
        {error && <p className="ops-error">{error}</p>}
        {done && <p className="form-success">{done}</p>}
      </section>

      {form.onlineOrders && (
        <section className="admin-panel">
          <div className="panel-title">
            <div>
              <h2>Share your menu</h2>
              <p className="muted">
                Send the link on WhatsApp or social media, or print the QR code on fliers and table
                cards. It always shows today’s menu and prices.
              </p>
            </div>
          </div>
          <div className="online-share">
            <div className="online-qr">
              {qr && <img src={qr} alt="QR code for the online menu" />}
            </div>
            <div className="online-link">
              <label className="setup-field">
                Link
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
              </label>
              <div className="platform-actions">
                <button className="setup-secondary" onClick={() => void copy()}>
                  <Copy aria-hidden /> Copy link
                </button>
                {'share' in navigator && (
                  <button className="setup-secondary" onClick={() => void share()}>
                    <Share2 aria-hidden /> Share
                  </button>
                )}
                <a className="setup-secondary" href={link} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden /> Open
                </a>
                {qr && (
                  <a
                    className="setup-secondary"
                    href={qr}
                    download={`${config.restaurantName || 'menu'} QR code.png`}
                  >
                    <Download aria-hidden /> QR code (PNG)
                  </a>
                )}
              </div>
            </div>
          </div>

          <h3 className="online-subhead">Printed flier</h3>
          <div className="online-flier">
            <div className="online-flier-form">
              <label className="setup-field">
                Paper
                <select value={size} onChange={(e) => setSize(e.target.value as FlierSize)}>
                  <option value="a4">A4 flier or poster</option>
                  <option value="a5">A5 flier</option>
                  <option value="cards">Table cards (4 on an A4 page)</option>
                </select>
              </label>
              <label className="setup-field">
                Headline
                <input
                  value={headline}
                  maxLength={40}
                  onChange={(e) => setHeadline(e.target.value)}
                />
              </label>
              <label className="setup-field">
                Under it
                <input
                  value={subline}
                  maxLength={80}
                  onChange={(e) => setSubline(e.target.value)}
                />
              </label>
              <button
                className="primary-button"
                disabled={!qr}
                onClick={() =>
                  void printDocument(
                    `${config.restaurantName} flier`,
                    flierCss(flier),
                    flierHtml(flier),
                  )
                }
              >
                <Printer aria-hidden /> Print
              </button>
              <small className="muted">
                Print at 100% (no “fit to page”) so the QR code stays sharp. Choose “Save as PDF” to
                send it to a printing shop.
              </small>
            </div>
            <div className={`online-flier-preview ${size}`}>
              <iframe title="Flier preview" srcDoc={preview} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
