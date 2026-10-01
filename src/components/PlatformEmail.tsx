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
  templates: Record<string, string>;
  kinds: EmailKind[];
};
type EmailKind = { key: string; label: string; when: string; subject: string; variables: string[] };

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
    templates: {} as Record<string, string>,
  });
  const [testTo, setTestTo] = useState(() => {
    try {
      return localStorage.getItem('relay:email-test-to') || '';
    } catch {
      return '';
    }
  });
  // Each template row's last result (test sent, HTML copied, or what failed).
  const [rows, setRows] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [sending, setSending] = useState('');
  const [templatesNote, setTemplatesNote] = useState<{ ok: boolean; text: string } | null>(null);
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
        templates: next.templates || {},
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
  const setTemplate = (kind: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, templates: { ...f.templates, [kind]: e.target.value } }));
  // Copies the email's HTML for the service's template editor.
  const note = (kind: string, ok: boolean, text: string) =>
    setRows((all) => ({ ...all, [kind]: { ok, text } }));
  const copyHtml = async (kind: EmailKind) => {
    try {
      const t: { html: string; brevoHtml: string } = await Parse.Cloud.run(
        'platformEmailTemplate',
        { kind: kind.key },
      );
      await navigator.clipboard.writeText(form.provider === 'brevo' ? t.brevoHtml : t.html);
      note(kind.key, true, 'HTML copied. Paste it into the template editor.');
    } catch (e) {
      note(kind.key, false, `Could not copy: ${message(e)}`);
    }
  };
  const validTo = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(testTo.trim());
  // Sends one kind with example values, through the template ID typed in its
  // row (saved or not).
  const sendTest = async (kind: EmailKind) => {
    if (!data?.ready) {
      note(kind.key, false, 'Save the email service, API key and sender address above first.');
      return;
    }
    if (!validTo) {
      note(kind.key, false, 'Enter the address to send tests to, above the table.');
      return;
    }
    try {
      localStorage.setItem('relay:email-test-to', testTo.trim());
    } catch {
      // Remembering the address is only a convenience.
    }
    setSending(kind.key);
    try {
      const result: { template: string } = await Parse.Cloud.run('platformTestEmail', {
        to: testTo.trim(),
        kind: kind.key,
        template: form.templates[kind.key] || '',
      });
      note(
        kind.key,
        true,
        `Sent to ${testTo.trim()} ${
          result.template ? `with template ${result.template}` : "with Relay's own design"
        }. Check your inbox (and spam).`,
      );
    } catch (e) {
      note(kind.key, false, message(e));
    } finally {
      setSending('');
    }
  };
  const saveTemplates = async () => {
    setBusy(true);
    setTemplatesNote(null);
    try {
      await Parse.Cloud.run('platformSaveEmail', { templates: form.templates });
      setTemplatesNote({ ok: true, text: 'Templates saved.' });
      await load();
    } catch (e) {
      setTemplatesNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
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
      {data && (
        <div className="email-templates">
          <h3>Templates</h3>
          <p className="muted">
            Relay sends its own designed emails. To edit one in{' '}
            {PROVIDER_NAMES[form.provider] || form.provider} instead: copy its HTML, create a
            template there (paste the HTML, set the subject shown here, add each variable), publish
            it and enter its {form.provider === 'brevo' ? 'number' : 'ID or alias'} below. Leave it
            empty to keep Relay&apos;s own. Send each one to yourself to check it, then save.
          </p>
          <label className="setup-field email-test-to">
            Send tests to
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@yourdomain.com"
            />
            {!data.ready && (
              <small className="form-error">
                Save the email service, API key and sender address above before sending tests.
              </small>
            )}
          </label>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Subject and variables</th>
                  <th>Template {form.provider === 'brevo' ? 'number' : 'ID or alias'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.kinds.map((kind) => (
                  <tr key={kind.key}>
                    <td>
                      <strong>{kind.label}</strong>
                      <small className="muted block">{kind.when}</small>
                    </td>
                    <td>
                      <code className="email-subject">{kind.subject}</code>
                      <small className="muted block">{kind.variables.join(', ')}</small>
                    </td>
                    <td>
                      <input
                        aria-label={`${kind.label} template`}
                        value={form.templates[kind.key] || ''}
                        onChange={setTemplate(kind.key)}
                        placeholder="Relay's own"
                      />
                    </td>
                    <td className="email-template-actions">
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void copyHtml(kind)}
                        >
                          Copy HTML
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={sending === kind.key}
                          onClick={() => void sendTest(kind)}
                        >
                          {sending === kind.key ? 'Sending…' : 'Send test'}
                        </button>
                      </div>
                      {rows[kind.key] && (
                        <small
                          role="status"
                          className={rows[kind.key].ok ? 'form-success' : 'form-error'}
                        >
                          {rows[kind.key].text}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="platform-actions">
            <button className="primary-button" disabled={busy} onClick={() => void saveTemplates()}>
              Save templates
            </button>
            {templatesNote && (
              <span className={templatesNote.ok ? 'form-success' : 'form-error'}>
                {templatesNote.text}
              </span>
            )}
          </div>
        </div>
      )}
      {!data && error && <p className="ops-error">{error}</p>}
    </section>
  );
}
