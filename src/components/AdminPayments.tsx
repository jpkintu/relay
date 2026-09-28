import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useAdminRun } from '../lib/adminRun';
import { useCloud } from './reports/common';

type Provider = 'mtn' | 'airtel';
type ProviderView = {
  enabled: boolean;
  configured: boolean;
  environment: 'sandbox' | 'production';
  targetEnvironment?: string;
  country?: string;
  keys: Record<string, string>;
  lastTest: { ok: boolean; message: string; at: string } | null;
};
type View = { mtn: ProviderView; airtel: ProviderView; dialCode: string; currency: string };

const FIELDS: Record<Provider, [string, string, string][]> = {
  mtn: [
    [
      'subscriptionKey',
      'Collection subscription key (Primary key)',
      'From your MTN MoMo developer profile → Subscriptions → Collections',
    ],
    ['apiUser', 'API user', 'A UUID. Live: from the MTN partner portal. Test: Relay can create it'],
    ['apiKey', 'API key', 'Live: from the MTN partner portal. Test: Relay can create it'],
  ],
  airtel: [
    ['clientId', 'Client ID', 'Airtel developer portal → your app → Keys'],
    ['clientSecret', 'Client secret', 'Shown next to the client ID'],
  ],
};
const LABEL: Record<Provider, string> = { mtn: 'MTN MoMo', airtel: 'Airtel Money' };

// Admin → Payments: automatic mobile money. With keys saved and switched on,
// riders and cashiers can send a payment request to the customer's phone
// instead of typing the transaction ID; the payment then confirms itself.
// Off (the default), everything works as before: the transaction ID is typed
// and a cashier confirms it.
export function AdminPayments() {
  const { data, error, reload } = useCloud<View>('adminGetPaymentSettings', {});
  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="data-page">
      <p className="section-intro">
        Automatic payments send a payment request to the customer’s phone; they approve it with
        their mobile money PIN and the payment is confirmed on its own. The manual way stays
        available at all times: the customer pays your merchant code, the rider or cashier types the
        transaction ID, and a cashier confirms it. Automatic payments stay off until you add your
        keys and switch them on.
      </p>
      {(['mtn', 'airtel'] as Provider[]).map((provider) => (
        <ProviderCard
          key={`${provider}-${JSON.stringify(data[provider])}`}
          provider={provider}
          view={data[provider]}
          dialCode={data.dialCode}
          onSaved={reload}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  view,
  dialCode,
  onSaved,
}: {
  provider: Provider;
  view: ProviderView;
  dialCode: string;
  onSaved: () => void;
}) {
  const adminRun = useAdminRun();
  const [enabled, setEnabled] = useState(view.enabled);
  const [environment, setEnvironment] = useState(view.environment);
  const [target, setTarget] = useState(view.targetEnvironment || 'mtnuganda');
  const [country, setCountry] = useState(view.country || 'UG');
  const [dial, setDial] = useState(dialCode);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState(view.lastTest);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      await adminRun('adminSavePaymentSettings', {
        provider,
        enabled,
        environment,
        dialCode: dial,
        ...(provider === 'mtn' ? { targetEnvironment: target } : { country }),
        ...keys,
      });
      setKeys({});
      setNotice('Saved.');
      onSaved();
    });

  return (
    <section className={`admin-panel pay-card momo-${provider}`}>
      <div className="panel-title">
        <h2>{LABEL[provider]}</h2>
        <span className={`status-pill ${view.enabled ? 'good' : ''}`}>
          {view.enabled ? 'Automatic: on' : 'Automatic: off'}
        </span>
      </div>
      <form
        className="setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="setup-field">
          Environment
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as ProviderView['environment'])}
          >
            <option value="sandbox">Test (sandbox): no real money</option>
            <option value="production">Live: real payments</option>
          </select>
        </label>
        {provider === 'mtn' ? (
          <label className="setup-field">
            Target environment (live)
            <input value={target} onChange={(e) => setTarget(e.target.value.trim())} />
          </label>
        ) : (
          <label className="setup-field">
            Country (two letters)
            <input
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </label>
        )}
        {FIELDS[provider].map(([field, label, hint]) => (
          <label className="setup-field" key={field}>
            {label}
            <input
              type="password"
              autoComplete="off"
              value={keys[field] || ''}
              placeholder={
                view.keys[field] ? `Saved (${view.keys[field]}): leave empty to keep` : hint
              }
              onChange={(e) => setKeys((current) => ({ ...current, [field]: e.target.value }))}
            />
          </label>
        ))}
        <label className="setup-field">
          Country calling code
          <input value={dial} inputMode="numeric" onChange={(e) => setDial(e.target.value)} />
        </label>
        <label className="setup-checkbox full-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Offer automatic {LABEL[provider]} payments to riders and cashiers
        </label>
        <div className="data-actions full-row">
          <button className="setup-submit" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="setup-secondary"
            disabled={busy || !view.configured}
            onClick={() =>
              void act(async () =>
                setTest({
                  ...(await adminRun<{ ok: boolean; message: string }>(
                    'adminTestPaymentConnection',
                    { provider },
                  )),
                  at: new Date().toISOString(),
                }),
              )
            }
          >
            Test the keys
          </button>
          {provider === 'mtn' && view.environment === 'sandbox' && view.keys.subscriptionKey && (
            <button
              type="button"
              className="setup-secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await adminRun('adminMtnSandboxUser', {});
                  setNotice('Test API user and key created and saved.');
                  onSaved();
                })
              }
            >
              Create test API user and key
            </button>
          )}
        </div>
      </form>
      {test && (
        <p className={test.ok ? 'pay-test good' : 'pay-test bad'}>
          {test.ok ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />} {test.message}
        </p>
      )}
      {notice && <p className="setup-notice">{notice}</p>}
      {error && <p className="ops-error">{error}</p>}
      <p className="muted small">
        {provider === 'mtn'
          ? 'Keys come from momodeveloper.mtn.com (test) and the MTN MoMo partner portal (live). The test sandbox charges in EUR with test numbers; live uses your currency.'
          : 'Keys come from the Airtel Money developer portal (developers.airtel.africa). If your Airtel app has message signing switched on, ask Airtel to switch it off for this app.'}
      </p>
    </section>
  );
}
