import { useEffect, useState } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useAdminRun } from '../lib/adminRun';
import { useConfig } from '../lib/session';
import { formatDate } from '../lib/format';
import { useCloud } from './reports/common';

type View = {
  // Relay Hosted: the platform's WhatsApp number sends; only the numbers are set here.
  managed: boolean;
  sender: string;
  enabled: boolean;
  phoneNumberId: string;
  tokenSet: boolean;
  templateName: string;
  language: string;
  recipients: string[];
  lastResult: { day: string; at: string; sent: number; failed: number; error: string } | null;
};

// Admin → WhatsApp: the daily Z-report summary sent to the owner's numbers
// through the WhatsApp Business Cloud API (cloud/whatsapp.js).
export function AdminWhatsApp() {
  const { timezone } = useConfig();
  const adminRun = useAdminRun();
  const { data, error, reload } = useCloud<View>('adminGetWhatsAppSettings', {});
  const [form, setForm] = useState({
    enabled: false,
    phoneNumberId: '',
    token: '',
    templateName: '',
    language: 'en',
    recipients: '',
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (!data) return;
    setForm({
      enabled: data.enabled,
      phoneNumberId: data.phoneNumberId,
      token: '',
      templateName: data.templateName,
      language: data.language,
      recipients: data.recipients.join('\n'),
    });
  }, [data]);

  const act = async (name: string, params: Record<string, unknown>, done: string) => {
    setBusy(true);
    setNotice('');
    setSaveError('');
    try {
      const result = await adminRun<{ sent?: number }>(name, params);
      setNotice(result?.sent !== undefined ? `Sent to ${result.sent} number(s).` : done);
      reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const last = data.lastResult;
  return (
    <div className="data-page">
      {data.managed ? (
        <p className="section-intro">
          Every night, when the Z-report is saved, Relay sends its summary (orders, sales, how
          customers paid, cash still with riders, till differences) to the numbers below on WhatsApp
          {data.sender ? (
            <>
              , from <b>{data.sender}</b>
            </>
          ) : (
            ''
          )}
          . Just add the numbers and switch it on.
        </p>
      ) : (
        <>
          <p className="section-intro">
            Every night, when the Z-report is saved, Relay can send its summary (orders, sales, how
            customers paid, cash still with riders, till differences) to your WhatsApp. It uses the
            WhatsApp Business Cloud API from Meta, with your own WhatsApp Business number.
          </p>
          <details className="admin-panel whatsapp-help">
            <summary>Where to find the phone number ID and access token</summary>
            <ol>
              <li>
                At developers.facebook.com, open your app (or create one of type <b>Business</b>).
                In <b>Use cases</b>, choose <b>Add use case</b> →{' '}
                <b>Connect with customers through WhatsApp</b>, and link or create your WhatsApp
                Business account.
              </li>
              <li>
                Open <b>WhatsApp → API Setup</b>. The <b>Phone number ID</b> is shown under the
                sending number (a test number at first; add your real number there with{' '}
                <b>Add phone number</b>). The token on that page expires after 24 hours: use it only
                to try things out.
              </li>
              <li>
                For a token that does not expire: in Meta Business settings →{' '}
                <b>Users → System users</b>, add a system user (Admin), give it your app and your
                WhatsApp account under <b>Assign assets</b> (full control), then{' '}
                <b>Generate token</b> for your app with the permissions{' '}
                <b>whatsapp_business_messaging</b> and <b>whatsapp_business_management</b>, set to
                never expire.
              </li>
              <li>
                In WhatsApp Manager → <b>Message templates</b>, create a <b>Utility</b> template
                whose body has one variable, for example “Daily summary: {'{{1}}'}”, and wait for it
                to be approved. Enter its name below. Without a template, WhatsApp only delivers to
                numbers that messaged your business in the last 24 hours.
              </li>
              <li>
                While the app is unpublished or on the test number, add each receiving number under{' '}
                <b>API Setup → To</b> and confirm the code WhatsApp sends it.
              </li>
            </ol>
            <p className="muted small">
              The app secret on the app's Basic settings page is not needed here; never share it.
            </p>
          </details>
        </>
      )}
      <form
        className="admin-panel spending-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            'adminSaveWhatsAppSettings',
            {
              ...form,
              recipients: form.recipients
                .split(/[\n,]+/)
                .map((v) => v.trim())
                .filter(Boolean),
            },
            'Saved.',
          );
        }}
      >
        <div className="spending-fields">
          {!data.managed && (
            <>
              <label className="setup-field">
                Phone number ID
                <input
                  value={form.phoneNumberId}
                  onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}
                  inputMode="numeric"
                  placeholder="From WhatsApp → API setup"
                />
              </label>
              <label className="setup-field">
                Access token
                <input
                  type="password"
                  value={form.token}
                  onChange={(e) => setForm({ ...form, token: e.target.value })}
                  placeholder={data.tokenSet ? 'Saved (leave empty to keep it)' : 'Permanent token'}
                  autoComplete="off"
                />
              </label>
              <label className="setup-field">
                Template name
                <input
                  value={form.templateName}
                  onChange={(e) => setForm({ ...form, templateName: e.target.value })}
                  placeholder="e.g. daily_summary (empty: plain text)"
                />
              </label>
              <label className="setup-field">
                Template language
                <input
                  value={form.language}
                  onChange={(e) => setForm({ ...form, language: e.target.value })}
                  placeholder="en"
                />
              </label>
            </>
          )}
          <label className="setup-field full-row">
            Send to (one number per line, up to 10)
            <textarea
              rows={3}
              value={form.recipients}
              onChange={(e) => setForm({ ...form, recipients: e.target.value })}
              placeholder={'0772 123456\n0701 234567'}
            />
          </label>
          <label className="setup-checkbox full-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />{' '}
            Send the daily summary on WhatsApp
          </label>
        </div>
        {saveError && <p className="form-error">{saveError}</p>}
        {notice && <p className="setup-notice">{notice}</p>}
        <div className="payment-actions">
          <button disabled={busy}>Save</button>
          <button
            type="button"
            className="setup-secondary"
            disabled={busy || (!data.managed && !data.tokenSet) || !data.recipients.length}
            onClick={() => void act('adminTestWhatsApp', {}, 'Sent.')}
          >
            Send today’s summary now
          </button>
        </div>
      </form>
      {last && (
        <p className={`momo-status ${last.failed ? 'bad' : 'good'}`}>
          {last.failed ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />} Last summary (
          {last.day}): sent to {last.sent}
          {last.failed ? `, failed for ${last.failed}: ${last.error}` : ''} ·{' '}
          {formatDate(last.at, timezone, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      )}
    </div>
  );
}
