import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import Parse from '../parse';
import { useSession } from '../lib/session';
import { MenuImport } from './MenuImport';
import { useAdminRun } from '../lib/adminRun';
import { STEP_COUNT, STEP_ORDER, stepsDone, type SetupProgress } from '../lib/setup';

type Settings = Record<string, unknown> & {
  restaurantName?: string;
  currencyCode?: string;
  currencySymbol?: string;
  timezone?: string;
};

function Step({
  done,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  done: boolean;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={done ? 'start-step done' : 'start-step'}>
      <button className="start-step-head" aria-expanded={open} onClick={onToggle}>
        {done ? <CheckCircle2 aria-label="Done" /> : <Circle aria-label="To do" />}
        <span>
          <b>{title}</b>
          <small>{summary}</small>
        </span>
      </button>
      {open && <div className="start-step-body">{children}</div>}
    </section>
  );
}

// A team member form for the first rider or cashier.
function FirstMember({ role, onCreated }: { role: 'rider' | 'cashier'; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState('');
  return (
    <form
      className="setup-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const member = await Parse.Cloud.run('adminCreateTeamMember', {
            name,
            username,
            phone,
            pin,
            role,
          });
          setCreated(
            `${member.name} (${member.code}) can now sign in as “${member.username}” with the PIN you chose.`,
          );
          setName('');
          setUsername('');
          setPhone('');
          setPin('');
          onCreated();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not create');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="setup-field">
        Full name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="setup-field">
        Username (what they sign in with)
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
          autoCapitalize="none"
          required
        />
      </label>
      <label className="setup-field">
        Phone
        <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
      </label>
      <label className="setup-field">
        PIN (4+ digits)
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <button className="setup-submit" disabled={busy}>
        {busy ? 'Creating…' : role === 'rider' ? 'Add rider' : 'Add cashier'}
      </button>
      {error && <p className="ops-error">{error}</p>}
      {created && <p className="setup-notice">{created}</p>}
    </form>
  );
}

// Admin → Get started: the steps to get a new restaurant taking orders.
export function AdminStart({
  onChanged,
  goTo,
}: {
  onChanged: () => void;
  goTo: (section: 'Branding' | 'Menu' | 'Team' | 'Settings' | 'Overview') => void;
}) {
  const { refresh } = useSession();
  const adminRun = useAdminRun();
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [open, setOpen] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      const [next, setup] = await Promise.all([
        Parse.Cloud.run('getSetupProgress') as Promise<SetupProgress>,
        Parse.Cloud.run('adminListSetup') as Promise<{ settings: Settings | null }>,
      ]);
      setProgress(next);
      setSettings((current) => ({ ...(setup.settings || {}), ...current }));
      setOpen((current) => current || STEP_ORDER.find((step) => !next.steps[step]) || '');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load setup');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    await load();
    onChanged();
  };

  const saveDetails = async () => {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      // The Settings page's other values stay as they are.
      await adminRun('adminSaveSettings', {
        defaultDeliveryFee: 3000,
        maxRiderFloat: 200000,
        ...settings,
      });
      await refresh();
      setSaved('Saved.');
      await changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const finish = async (done: boolean) => {
    setBusy(true);
    try {
      await Parse.Cloud.run('adminFinishSetup', { done });
      await changed();
      if (done) goTo('Overview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (!progress)
    return error ? <p className="ops-error">{error}</p> : <p className="muted">Loading…</p>;
  const toggle = (step: string) => setOpen((current) => (current === step ? '' : step));
  const field = (label: string, key: keyof Settings, hint = '') => (
    <label className="setup-field">
      {label}
      <input
        value={String(settings[key] ?? '')}
        placeholder={hint}
        onChange={(e) => setSettings((current) => ({ ...current, [key]: e.target.value }))}
      />
    </label>
  );
  const done = stepsDone(progress);
  const named = !!settings.restaurantName && settings.restaurantName !== 'Restaurant';
  return (
    <div className="start-page">
      <div className="start-progress">
        <p>
          <b>
            {done} of {STEP_COUNT} done.
          </b>{' '}
          {progress.complete
            ? `${named ? settings.restaurantName : 'Your restaurant'} is ready to take orders.`
            : 'Finish these and your team can start taking orders.'}
        </p>
        <div
          className="start-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={STEP_COUNT}
          aria-valuenow={done}
        >
          <span style={{ width: `${(done / STEP_COUNT) * 100}%` }} />
        </div>
      </div>
      {error && <p className="ops-error">{error}</p>}

      <Step
        done={progress.steps.details}
        title="1. Your restaurant"
        summary={
          progress.steps.details
            ? `${settings.restaurantName} · ${settings.currencyCode} · ${settings.timezone}`
            : 'Name, currency and time zone'
        }
        open={open === 'details'}
        onToggle={() => toggle('details')}
      >
        <form
          className="setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDetails();
          }}
        >
          {field('Restaurant name', 'restaurantName', 'e.g. Mama Rose Kitchen')}
          {field('Time zone', 'timezone', 'e.g. Africa/Kampala')}
          {field('Currency code', 'currencyCode', 'e.g. UGX, KES, USD')}
          {field('Currency symbol shown on prices', 'currencySymbol', 'e.g. UGX, KSh, $')}
          <button className="setup-submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {saved && <p className="setup-notice">{saved}</p>}
        </form>
        <p className="muted small">
          Delivery fee, cash limits, mobile money numbers and receipts are under{' '}
          <button className="link-button" onClick={() => goTo('Settings')}>
            Settings
          </button>
          .
        </p>
      </Step>

      <Step
        done={progress.steps.menu}
        title="2. Your menu"
        summary={
          progress.steps.menu
            ? `${progress.dishes} dish${progress.dishes === 1 ? '' : 'es'} on the menu`
            : progress.starterDishes
              ? `Replace the ${progress.starterDishes} example dishes with yours`
              : 'Add your dishes'
        }
        open={open === 'menu'}
        onToggle={() => toggle('menu')}
      >
        <MenuImport starterDishes={progress.starterDishes} onImported={() => void changed()} />
        <p className="muted small">
          Or add dishes one at a time, with photos and sides, on the{' '}
          <button className="link-button" onClick={() => goTo('Menu')}>
            Menu page
          </button>
          .
        </p>
      </Step>

      <Step
        done={progress.steps.riders}
        title="3. Your first rider"
        summary={
          progress.riders
            ? `${progress.riders} rider${progress.riders === 1 ? '' : 's'}`
            : 'Riders take orders and deliver them'
        }
        open={open === 'riders'}
        onToggle={() => toggle('riders')}
      >
        <FirstMember role="rider" onCreated={() => void changed()} />
      </Step>

      <Step
        done={progress.steps.cashiers}
        title="4. Your first cashier"
        summary={
          progress.cashiers
            ? `${progress.cashiers} cashier${progress.cashiers === 1 ? '' : 's'}`
            : 'Cashiers run the kitchen board and count riders’ cash'
        }
        open={open === 'cashiers'}
        onToggle={() => toggle('cashiers')}
      >
        <FirstMember role="cashier" onCreated={() => void changed()} />
        <p className="muted small">
          Add more people, set pay and cash limits on the{' '}
          <button className="link-button" onClick={() => goTo('Team')}>
            Team page
          </button>
          .
        </p>
      </Step>

      <Step
        done={progress.steps.logo}
        title="5. Your logo and colours (optional)"
        summary={
          progress.steps.logo ? 'Logo added' : 'Shown on the sign-in screen, receipts and the board'
        }
        open={open === 'logo'}
        onToggle={() => toggle('logo')}
      >
        <button className="setup-submit" onClick={() => goTo('Branding')}>
          Open Branding
        </button>
      </Step>

      <div className="start-finish">
        {progress.finished ? (
          <button className="link-button" disabled={busy} onClick={() => void finish(false)}>
            Show Get started in the menu again
          </button>
        ) : (
          <>
            <button className="setup-submit" disabled={busy} onClick={() => void finish(true)}>
              {progress.complete ? 'Finish setup' : 'Hide Get started for now'}
            </button>
            <p className="muted small">
              {progress.complete
                ? 'Get started leaves the menu. Everything here can still be changed on its own page.'
                : 'You can come back to it from the Overview.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
