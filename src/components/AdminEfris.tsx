import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useAdminRun } from '../lib/adminRun';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';
import { useCloud } from './reports/common';

type Settings = {
  enabled: boolean;
  since: string | null;
  environment: 'test' | 'production';
  tin: string;
  ninBrn: string;
  legalName: string;
  businessName: string;
  address: string;
  mobilePhone: string;
  emailAddress: string;
  placeOfBusiness: string;
  deviceNo: string;
  commodityCategoryId: string;
  unitOfMeasure: string;
  remarks: string;
  taxCategory: string;
  invoiceKind: string;
  keyLoaded: boolean;
  keyName: string;
  units: { value: string; name: string }[];
  lastTest: {
    ok: boolean;
    at: string;
    message: string;
    taxpayer?: string;
    tinMatches?: boolean;
    vatRegistered?: boolean;
    deviceStatus?: string;
  } | null;
  goodsRegistered: number;
  missing: string[];
  taxOptions: { value: string; label: string }[];
  counts?: { issued: number; failed: number };
  certificate: { validUntil: string; fingerprint: string } | null;
};

type Files = {
  crt: { name: string; text: string };
  cer: { name: string; base64: string };
  fingerprint: string;
  validUntil: string;
};

// Saves a certificate to the owner's computer, to upload on the EFRIS portal.
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const saveCrt = (files: Files) =>
  download(files.crt.name, new Blob([files.crt.text], { type: 'application/x-x509-ca-cert' }));
const saveCer = (files: Files) =>
  download(
    files.cer.name,
    new Blob([Uint8Array.from(atob(files.cer.base64), (c) => c.charCodeAt(0))], {
      type: 'application/pkix-cert',
    }),
  );

type Form = Omit<
  Settings,
  | 'enabled'
  | 'since'
  | 'keyLoaded'
  | 'keyName'
  | 'units'
  | 'lastTest'
  | 'goodsRegistered'
  | 'missing'
  | 'taxOptions'
  | 'counts'
  | 'certificate'
>;

const TEXT: [keyof Form, string, string][] = [
  ['legalName', 'Legal name', 'As registered with URA'],
  ['businessName', 'Business name', 'The trading name, if different'],
  ['ninBrn', 'NIN / BRN', 'Business registration number'],
  ['emailAddress', 'Email address', 'The email on your EFRIS account'],
  ['mobilePhone', 'Phone', ''],
  ['placeOfBusiness', 'Place of business', ''],
];

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });

// Admin → Tax: URA EFRIS fiscal receipts. Optional; off until the owner
// connects the restaurant's EFRIS account, tests it and switches it on. Then
// every completed sale gets an FDN, verification code and QR code, printed on
// its receipt.
export function AdminEfris() {
  const { data, error, reload } = useCloud<Settings>('adminGetEfrisSettings', {});
  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return <EfrisForm key={JSON.stringify(data)} view={data} onSaved={reload} />;
}

function EfrisForm({ view, onSaved }: { view: Settings; onSaved: () => void }) {
  const adminRun = useAdminRun();
  const { timezone } = useConfig();
  const [form, setForm] = useState<Form>(() => ({
    environment: view.environment,
    tin: view.tin,
    ninBrn: view.ninBrn,
    legalName: view.legalName,
    businessName: view.businessName,
    address: view.address,
    mobilePhone: view.mobilePhone,
    emailAddress: view.emailAddress,
    placeOfBusiness: view.placeOfBusiness,
    deviceNo: view.deviceNo,
    commodityCategoryId: view.commodityCategoryId,
    unitOfMeasure: view.unitOfMeasure,
    remarks: view.remarks,
    taxCategory: view.taxCategory,
    invoiceKind: view.invoiceKind,
  }));
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [keyPassword, setKeyPassword] = useState('');
  const [keyError, setKeyError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);
  const set = (field: keyof Form) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const when = (at: string | null) =>
    formatDate(at, timezone, { dateStyle: 'medium', timeStyle: 'short' });

  const act = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      setNotice(await work());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy('');
    }
  };
  const save = (extra: Record<string, unknown> = {}) =>
    act('save', async () => {
      const key = keyFile ? await readFile(keyFile) : undefined;
      await adminRun('adminSaveEfrisSettings', {
        ...form,
        ...(key && { key, keyPassword, keyName: keyFile!.name }),
        ...extra,
      });
      return 'enabled' in extra ? (extra.enabled ? 'EFRIS is on.' : 'EFRIS is off.') : 'Saved.';
    });
  const test = () =>
    act('test', async () => {
      const result = await adminRun<Settings>('adminTestEfris', {});
      return result.lastTest?.ok ? 'Connected to EFRIS.' : '';
    });
  const register = () =>
    act('register', async () => {
      const result = await adminRun<{
        registered: number;
        failures: { name: string; message: string }[];
      }>('adminRegisterEfrisGoods', {});
      setFailures(result.failures);
      return result.failures.length
        ? `${result.failures.length} dish(es) were refused; see below.`
        : `Menu registered with EFRIS (${result.registered} items).`;
    });

  // Only a private key goes here; its certificate goes to the EFRIS portal.
  const keyInput = (
    <>
      <input
        type="file"
        accept=".pfx,.p12,.pem,.key"
        onChange={(e) => {
          const file = e.target.files?.[0] || null;
          if (file && /\.(crt|cer|der)$/i.test(file.name)) {
            setKeyError(
              'That file is the certificate: upload it on the EFRIS portal. RelayEats needs the private key; if you made the key pair here, it is already saved.',
            );
            e.target.value = '';
            setKeyFile(null);
            return;
          }
          setKeyError('');
          setKeyFile(file);
        }}
      />
      {keyError && <span className="ops-error efris-key-error">{keyError}</span>}
    </>
  );
  const t = view.lastTest;
  return (
    <div className="data-page">
      <p className="section-intro">
        With EFRIS on, every completed sale (delivered, served or paid) is sent to URA and gets a
        fiscal document number (FDN), verification code and QR code, printed on its receipt. It is
        optional and stays off until you connect your EFRIS account, test it and switch it on. Only
        sales made after you switch it on are sent.
      </p>

      <section className="admin-panel">
        <div className="panel-title">
          <h2>EFRIS</h2>
          <span className={`status-pill ${view.enabled ? 'good' : ''}`}>
            {view.enabled ? `On since ${when(view.since)}` : 'Off'}
          </span>
        </div>
        {view.counts && (view.counts.issued > 0 || view.counts.failed > 0) && (
          <p className="muted small">
            {view.counts.issued} sale(s) issued
            {view.counts.failed > 0 && (
              <>
                {' '}
                · <b>{view.counts.failed} waiting to be sent again</b> (RelayEats retries on its
                own; open the order to see why or send it now)
              </>
            )}
          </p>
        )}
        {view.missing.length > 0 && (
          <p className="muted small">Still needed: {view.missing.join(', ')}.</p>
        )}
        <div className="data-actions">
          {view.enabled ? (
            <button
              className="setup-secondary"
              disabled={!!busy}
              onClick={() => void save({ enabled: false })}
            >
              Switch EFRIS off
            </button>
          ) : (
            <button
              className="setup-submit"
              disabled={!!busy || !t?.ok || view.missing.length > 0}
              onClick={() => void save({ enabled: true })}
            >
              Switch EFRIS on
            </button>
          )}
        </div>
      </section>

      <form
        className="admin-panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="panel-title">
          <h2>1. Your EFRIS account</h2>
        </div>
        <p className="muted small">
          On the EFRIS portal (efris.ura.go.ug): register a system-to-system device to get its
          device number. For the key pair, either let RelayEats make one below (then upload the
          certificate it gives you on the portal), or choose your own private key (a .pfx / .p12
          keystore or a .pem file) whose certificate is already on the portal. The private key stays
          on the server and is never shown again. Use the test environment first.
        </p>
        <div className="setup-form">
          <label className="setup-field">
            Environment
            <select value={form.environment} onChange={(e) => set('environment')(e.target.value)}>
              <option value="test">Test (efristest): not real</option>
              <option value="production">Live: real fiscal receipts</option>
            </select>
          </label>
          <label className="setup-field">
            TIN
            <input
              inputMode="numeric"
              maxLength={10}
              value={form.tin}
              onChange={(e) => set('tin')(e.target.value.trim())}
            />
          </label>
          <label className="setup-field">
            Device number
            <input
              value={form.deviceNo}
              placeholder="e.g. TCS9e0df01728335239"
              onChange={(e) => set('deviceNo')(e.target.value.trim())}
            />
          </label>
          {view.certificate ? (
            <details className="setup-field efris-own-key">
              <summary>Private key: made by RelayEats (saved). Use your own key instead…</summary>
              {keyInput}
            </details>
          ) : (
            <label className="setup-field">
              Private key {view.keyLoaded && <span className="muted">(saved: {view.keyName})</span>}
              {keyInput}
            </label>
          )}
          {keyFile && (
            <label className="setup-field">
              Keystore password
              <input
                type="password"
                autoComplete="off"
                value={keyPassword}
                onChange={(e) => setKeyPassword(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="data-actions">
          <button className="setup-submit" disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="setup-secondary"
            disabled={!!busy || !view.keyLoaded || !view.tin || !view.deviceNo}
            onClick={() => void test()}
          >
            {busy === 'test' ? 'Testing…' : 'Test the connection'}
          </button>
        </div>
        <KeyMaker
          view={view}
          busy={!!busy}
          beforeMake={async () => {
            // The TIN goes into the certificate: save what is typed first.
            await adminRun('adminSaveEfrisSettings', { ...form });
          }}
          onDone={onSaved}
          onError={setError}
        />
        {t && (
          <p className={t.ok ? 'pay-test good' : 'pay-test bad'}>
            {t.ok ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}{' '}
            {t.ok
              ? `Connected as ${t.taxpayer || 'your business'} · ${
                  t.vatRegistered ? 'VAT registered' : 'not VAT registered'
                }${t.tinMatches === false ? ' · the TIN does not match!' : ''} · ${when(t.at)}`
              : t.message}
          </p>
        )}

        <div className="panel-title efris-step">
          <h2>2. On the receipt</h2>
        </div>
        <p className="muted small">Filled in from EFRIS when you test the connection.</p>
        <div className="setup-form">
          {TEXT.map(([field, label, hint]) => (
            <label className="setup-field" key={field}>
              {label}
              <input
                value={String(form[field] || '')}
                placeholder={hint}
                onChange={(e) => set(field)(e.target.value)}
              />
            </label>
          ))}
        </div>

        <div className="panel-title efris-step">
          <h2>3. Menu and tax</h2>
        </div>
        <p className="muted small">
          Your dishes are registered with EFRIS as services under one commodity category (find the
          code on the EFRIS portal, e.g. the one for restaurant services). VAT registered
          restaurants issue tax invoices at 18%; others issue receipts.
        </p>
        <div className="setup-form">
          <label className="setup-field">
            Commodity category code
            <input
              inputMode="numeric"
              value={form.commodityCategoryId}
              placeholder="From the EFRIS portal"
              onChange={(e) => set('commodityCategoryId')(e.target.value.trim())}
            />
          </label>
          <label className="setup-field">
            Unit of measure
            {view.units.length ? (
              <select
                value={form.unitOfMeasure}
                onChange={(e) => set('unitOfMeasure')(e.target.value)}
              >
                <option value="">Choose…</option>
                {view.units.map((unit) => (
                  <option key={unit.value} value={unit.value}>
                    {unit.name} ({unit.value})
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.unitOfMeasure}
                placeholder="Test the connection to list URA's units"
                onChange={(e) => set('unitOfMeasure')(e.target.value.trim())}
              />
            )}
          </label>
          <label className="setup-field">
            Tax rate
            <select value={form.taxCategory} onChange={(e) => set('taxCategory')(e.target.value)}>
              <option value="">Choose…</option>
              {view.taxOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            Issue
            <select value={form.invoiceKind} onChange={(e) => set('invoiceKind')(e.target.value)}>
              <option value="">Choose…</option>
              <option value="invoice">Tax invoices (VAT registered)</option>
              <option value="receipt">Receipts (not VAT registered)</option>
            </select>
          </label>
          <label className="setup-field full-row">
            Remarks on every fiscal document (optional)
            <input
              value={form.remarks}
              maxLength={500}
              onChange={(e) => set('remarks')(e.target.value)}
            />
          </label>
        </div>
        <div className="data-actions">
          <button className="setup-submit" disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="setup-secondary"
            disabled={!!busy || !t?.ok}
            onClick={() => void register()}
          >
            {busy === 'register' ? 'Registering…' : 'Register the menu with EFRIS'}
          </button>
        </div>
        <p className="muted small">
          {view.goodsRegistered} item(s) registered. New and renamed dishes are registered on their
          own before their first sale.
        </p>
        {failures.length > 0 && (
          <ul className="ops-error">
            {failures.map((f) => (
              <li key={f.name}>
                {f.name}: {f.message}
              </li>
            ))}
          </ul>
        )}
      </form>
      {notice && <p className="setup-notice">{notice}</p>}
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}

// No key yet? Relay makes the key pair: the private key stays on the server,
// the certificate is downloaded and uploaded on the EFRIS portal.
function KeyMaker({
  view,
  busy,
  beforeMake,
  onDone,
  onError,
}: {
  view: Settings;
  busy: boolean;
  beforeMake: () => Promise<void>;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const adminRun = useAdminRun();
  const { timezone } = useConfig();
  const [working, setWorking] = useState(false);
  const [files, setFiles] = useState<Files | null>(null);
  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    onError('');
    try {
      await work();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setWorking(false);
    }
  };
  const make = () =>
    run(async () => {
      const replace = view.keyLoaded;
      if (
        replace &&
        !window.confirm(
          'Replace the saved key? Sales to EFRIS stop working until the new certificate is uploaded on the EFRIS portal.',
        )
      )
        return;
      await beforeMake();
      const made = await adminRun<Files>('adminGenerateEfrisKey', { replace });
      setFiles(made);
      saveCrt(made);
      onDone();
    });
  const again = () =>
    run(async () => {
      const got = files || (await adminRun<Files>('adminGetEfrisCertificate', {}));
      setFiles(got);
      saveCrt(got);
    });
  const cert = files ? { validUntil: files.validUntil } : view.certificate;
  return (
    <div className="efris-keymaker">
      {cert ? (
        <>
          <p className="muted small">
            Key made by RelayEats. Upload its certificate on the EFRIS portal (the certificate /
            public key upload). Valid until{' '}
            {formatDate(cert.validUntil, timezone, { dateStyle: 'medium' })}.
          </p>
          <div className="data-actions">
            <button
              type="button"
              className="setup-secondary"
              disabled={busy || working}
              onClick={() => void again()}
            >
              Download the certificate (.crt)
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy || working}
              onClick={() =>
                void run(async () => {
                  const got = files || (await adminRun<Files>('adminGetEfrisCertificate', {}));
                  setFiles(got);
                  saveCer(got);
                })
              }
            >
              .cer instead
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy || working}
              onClick={() => void make()}
            >
              Make a new key
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            {view.keyLoaded
              ? 'Your own key is saved. You can have RelayEats make one instead; you then upload its certificate on the EFRIS portal.'
              : 'No key pair yet? RelayEats can make one: the private key stays here, and you upload the certificate it gives you on the EFRIS portal. Enter your TIN first.'}
          </p>
          <div className="data-actions">
            <button
              type="button"
              className="setup-secondary"
              disabled={busy || working}
              onClick={() => void make()}
            >
              {working
                ? 'Making the key…'
                : view.keyLoaded
                  ? 'Make a new key here'
                  : 'Make a key pair'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
