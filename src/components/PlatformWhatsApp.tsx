import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Parse from '../parse';

// Relay Hosted, platform console: the one WhatsApp Business app that sends
// every restaurant's daily summary (cloud/platformWhatsapp.js). Restaurants
// then only choose the numbers that receive it (Admin → WhatsApp).

type Sender = {
  enabled: boolean;
  phoneNumberId: string;
  displayNumber: string;
  tokenSet: boolean;
  templateName: string;
  language: string;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PlatformWhatsApp() {
  const [data, setData] = useState<Sender | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    phoneNumberId: '',
    displayNumber: '',
    token: '',
    templateName: '',
    language: 'en',
  });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      const sender: Sender = await Parse.Cloud.run('platformGetWhatsApp');
      setData(sender);
      setForm({
        enabled: sender.enabled,
        phoneNumberId: sender.phoneNumberId,
        displayNumber: sender.displayNumber,
        token: '',
        templateName: sender.templateName,
        language: sender.language,
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
    void act('platformSaveWhatsApp', form, 'Saved.');
  };
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>WhatsApp sender</h2>
          <p className="muted">
            One WhatsApp Business number sends every restaurant&apos;s nightly summary. Once it is
            switched on, owners only enter the numbers that receive theirs (Admin → WhatsApp). Use a
            system-user token that never expires and an approved Utility template whose body has one
            variable, e.g. “Daily summary: {'{{1}}'}”; the variable starts with the
            restaurant&apos;s name.
          </p>
        </div>
      </div>
      {data && (
        <form className="platform-form" onSubmit={save}>
          <label className="setup-field">
            Phone number ID
            <input
              inputMode="numeric"
              value={form.phoneNumberId}
              onChange={set('phoneNumberId')}
              placeholder="WhatsApp → API Setup"
            />
          </label>
          <label className="setup-field">
            Number shown to restaurants
            <input
              value={form.displayNumber}
              onChange={set('displayNumber')}
              placeholder="e.g. +256 700 000000"
            />
          </label>
          <label className="setup-field">
            Access token
            <input
              type="password"
              autoComplete="off"
              value={form.token}
              onChange={set('token')}
              placeholder={data.tokenSet ? 'Saved (leave empty to keep it)' : 'System-user token'}
            />
          </label>
          <label className="setup-field">
            Template name
            <input
              value={form.templateName}
              onChange={set('templateName')}
              placeholder="e.g. daily_summary"
            />
          </label>
          <label className="setup-field">
            Template language
            <input value={form.language} onChange={set('language')} placeholder="en" />
          </label>
          <label className="setup-checkbox platform-note">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />{' '}
            Send every restaurant&apos;s summary from this number
          </label>
          {error && <p className="form-error platform-note">{error}</p>}
          {done && <p className="form-success platform-note">{done}</p>}
          <div className="platform-actions platform-note">
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save sender'}
            </button>
            <input
              className="platform-test-to"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Test number, e.g. 0772 123456"
              aria-label="Test number"
            />
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !data.tokenSet || !testTo.trim()}
              onClick={() => void act('platformTestWhatsApp', { to: testTo }, 'Test sent.')}
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
