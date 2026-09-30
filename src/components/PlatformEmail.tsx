import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Parse from '../parse';

// Relay Hosted, platform console: the email service Relay writes to
// restaurant owners with (password reset links, welcome, billing reminders).

type EmailSettings = {
  provider: string;
  from: string;
  fromName: string;
  appUrl: string;
  keySet: boolean;
  ready: boolean;
  providers: string[];
};

const PROVIDER_NAMES: Record<string, string> = { resend: 'Resend', brevo: 'Brevo' };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PlatformEmail() {
  const [data, setData] = useState<EmailSettings | null>(null);
  const [form, setForm] = useState({
    provider: 'resend',
    apiKey: '',
    from: '',
    fromName: 'Relay',
    appUrl: '',
  });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      const next: EmailSettings = await Parse.Cloud.run('platformGetEmail');
      setData(next);
      setForm({
        provider: next.provider,
        apiKey: '',
        from: next.from,
        fromName: next.fromName,
        appUrl: next.appUrl || window.location.origin,
      });
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, params: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await Parse.Cloud.run(name, params);
      setDone(ok);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void act('platformSaveEmail', form, 'Saved.');
  };
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>Email</h2>
          <p className="muted">
            How Relay writes to restaurant owners, at the email they gave at sign-up: password reset
            links, the welcome email and subscription reminders. Create an account with{' '}
            <a href="https://resend.com" target="_blank" rel="noreferrer">
              Resend
            </a>{' '}
            or{' '}
            <a href="https://www.brevo.com" target="_blank" rel="noreferrer">
              Brevo
            </a>
            , verify your sending domain there, and paste its API key here.
          </p>
        </div>
        {data && (
          <span className={`status-pill ${data.ready && data.appUrl ? 'good' : ''}`}>
            {data.ready && data.appUrl ? 'Sending' : 'Not set up'}
          </span>
        )}
      </div>
      {data && (
        <form className="platform-form" onSubmit={save}>
          <label className="setup-field">
            Email service
            <select value={form.provider} onChange={set('provider')}>
              {data.providers.map((key) => (
                <option key={key} value={key}>
                  {PROVIDER_NAMES[key] || key}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            API key
            <input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={set('apiKey')}
              placeholder={data.keySet ? 'Saved (leave empty to keep it)' : 'From the service'}
            />
          </label>
          <label className="setup-field">
            Send from
            <input
              type="email"
              value={form.from}
              onChange={set('from')}
              placeholder="e.g. no-reply@yourdomain.com"
            />
            <small>An address on the domain you verified with the service.</small>
          </label>
          <label className="setup-field">
            Sender name
            <input value={form.fromName} onChange={set('fromName')} placeholder="Relay" />
          </label>
          <label className="setup-field platform-note">
            The app&apos;s address (for links in emails)
            <input value={form.appUrl} onChange={set('appUrl')} placeholder="https://…" />
          </label>
          {error && <p className="form-error platform-note">{error}</p>}
          {done && <p className="form-success platform-note">{done}</p>}
          <div className="platform-actions platform-note">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save email settings'}
            </button>
            <input
              className="platform-test-to"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Send a test to…"
              aria-label="Test email address"
            />
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !data.ready || !testTo.trim()}
              onClick={() => void act('platformTestEmail', { to: testTo }, 'Test sent.')}
            >
              Send a test
            </button>
          </div>
        </form>
      )}
      {!data && error && <p className="ops-error">{error}</p>}
    </section>
  );
}
