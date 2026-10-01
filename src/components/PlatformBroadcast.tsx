import { useCallback, useEffect, useState } from 'react';
import Parse from '../parse';
import { formatDate } from '../lib/format';

// Relay Hosted, platform console: email restaurant owners (announcements,
// price changes, maintenance notices). cloud/platformBroadcast.js.

type Broadcast = {
  id: string;
  subject: string;
  audience: { status: string; plan: string };
  total: number;
  sent: number;
  failed: number;
  state: 'sending' | 'done';
  by: string;
  createdAt: string | null;
};
type Preview = { count: number; withoutEmail: number; sample: string[] };

const STATUSES: [string, string][] = [
  ['all', 'All owners'],
  ['trial', 'On free trial'],
  ['active', 'Paid'],
  ['past_due', 'Payment overdue'],
  ['expired', 'Closed (not paid)'],
];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PlatformBroadcast({
  plans,
  timeZone,
}: {
  plans: { key: string; name: string }[];
  timeZone: string;
}) {
  const [status, setStatus] = useState('all');
  const [plan, setPlan] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [testTo, setTestTo] = useState(() => {
    try {
      return localStorage.getItem('relay:email-test-to') || '';
    } catch {
      return '';
    }
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<Broadcast[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const loadHistory = useCallback(async () => {
    try {
      const { rows } = await Parse.Cloud.run('platformListBroadcasts');
      setHistory(rows);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);
  // Follow a send in progress.
  const sending = history.some((row) => row.state === 'sending');
  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => void loadHistory(), 3000);
    return () => window.clearInterval(timer);
  }, [sending, loadHistory]);

  useEffect(() => {
    let live = true;
    Parse.Cloud.run('platformBroadcastPreview', { status, plan })
      .then((next: Preview) => live && setPreview(next))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [status, plan]);

  const run = async (params: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await Parse.Cloud.run('platformSendBroadcast', {
        subject,
        message: body,
        status,
        plan,
        ...params,
      });
      setDone(ok);
      await loadHistory();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const sendTest = () => {
    try {
      localStorage.setItem('relay:email-test-to', testTo.trim());
    } catch {
      // Remembering the address is only a convenience.
    }
    void run({ testTo }, `Test sent to ${testTo.trim()}.`);
  };
  const sendAll = async () => {
    const count = preview?.count ?? 0;
    if (!window.confirm(`Email “${subject}” to ${count} owner${count === 1 ? '' : 's'}?`)) return;
    if (await run({}, `Sending to ${count} owner${count === 1 ? '' : 's'}…`)) {
      setSubject('');
      setBody('');
    }
  };
  const audienceLabel = (a: Broadcast['audience']) =>
    [
      STATUSES.find(([key]) => key === a.status)?.[1] || 'All owners',
      a.plan ? plans.find((p) => p.key === a.plan)?.name || a.plan : '',
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <section className="admin-panel broadcast">
      <div className="panel-title">
        <div>
          <h2>Email owners</h2>
          <p className="muted">
            Announcements, price changes or maintenance notices, to every owner you choose, at the
            email they gave at sign-up. Write <code>{'{restaurant}'}</code> or{' '}
            <code>{'{owner}'}</code> to use each restaurant&apos;s own.
          </p>
        </div>
      </div>
      <div className="platform-form">
        <label className="setup-field">
          Who
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setup-field">
          Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">All plans</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="platform-note broadcast-reach" role="status">
          {preview
            ? `Reaches ${preview.count} owner${preview.count === 1 ? '' : 's'}${
                preview.withoutEmail ? ` (${preview.withoutEmail} more have no email)` : ''
              }${preview.sample.length ? `: ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}` : ''}`
            : 'Counting…'}
        </p>
        <label className="setup-field platform-note">
          Subject
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={150}
            placeholder="e.g. New: WhatsApp daily summaries"
          />
        </label>
        <label className="setup-field platform-note">
          Message
          <textarea
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={5000}
            placeholder="Write as you would to one owner. Line breaks are kept."
          />
        </label>
        {error && <p className="form-error platform-note">{error}</p>}
        {done && <p className="form-success platform-note">{done}</p>}
        <div className="platform-actions platform-note">
          <input
            className="platform-test-to"
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="Send a test to…"
            aria-label="Test address"
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !testTo.trim()}
            onClick={sendTest}
          >
            Send test
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !preview?.count || subject.trim().length < 3}
            onClick={() => void sendAll()}
          >
            {preview?.count
              ? `Send to ${preview.count} owner${preview.count === 1 ? '' : 's'}`
              : 'Send'}
          </button>
        </div>
      </div>
      {history.length > 0 && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Sent</th>
                <th>Subject</th>
                <th>To</th>
                <th className="num">Delivered</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>
                    {formatDate(row.createdAt, timeZone, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    <small className="muted block">{row.by}</small>
                  </td>
                  <td>{row.subject}</td>
                  <td>{audienceLabel(row.audience)}</td>
                  <td className="num">
                    {row.sent} of {row.total}
                    {row.failed > 0 && (
                      <small className="form-error block">{row.failed} failed</small>
                    )}
                    {row.state === 'sending' && <small className="muted block">Sending…</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
