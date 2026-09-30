import { useEffect, useState } from 'react';
import { ArrowRight, Eye, LockKeyhole } from 'lucide-react';
import Parse from '../parse';
import { startGoogleSignIn } from '../lib/googleSignIn';

// Google sign-in is off (owner's decision 2026-09-28): staff sign in with a
// username and PIN. Build with VITE_ENABLE_GOOGLE_SIGNIN=true to show it again.
const GOOGLE_SIGN_IN = import.meta.env.VITE_ENABLE_GOOGLE_SIGNIN === 'true';
import { useSession } from '../lib/session';
import { AuthSide } from './AuthSide';
import { BrandMark } from './BrandMark';
import { planPoints, useOfferedPlans } from './Subscription';
import { formatMoney } from '../lib/format';
import { RelayMark } from './RelayMark';
import { useImageReady } from '../lib/imageReady';
import { normaliseCode, rememberRestaurant, signInName } from '../lib/restaurant';

// Staff usernames are stored in lowercase, but phone keyboards capitalize the
// first letter. Try the name as typed first (older accounts may use capitals),
// then the lowercase form.
async function logIn(typed: string, password: string): Promise<Parse.User> {
  const username = typed.trim();
  try {
    return await Parse.User.logIn(username, password);
  } catch (e) {
    const lower = username.toLowerCase();
    if (lower !== username && e instanceof Parse.Error && e.code === Parse.Error.OBJECT_NOT_FOUND)
      return Parse.User.logIn(lower, password);
    throw e;
  }
}

export function AuthScreen() {
  const {
    setUser,
    startPreview,
    appInfo,
    serverError,
    previewAvailable,
    restaurantCode,
    chooseRestaurant,
    error: sessionError,
  } = useSession();
  const [signingUp, setSigningUp] = useState(false);
  // Relay's own staff sign in at /platform (no restaurant).
  const platform = window.location.pathname.startsWith('/platform');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(sessionError);
  const [busy, setBusy] = useState(false);
  // Logo and name appear together, like the Relay mark and its credit.
  const logoReady = useImageReady(appInfo.restaurantLogo);
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      setUser(await logIn(signInName(username.trim(), restaurantCode), password));
    } catch (e) {
      setError(
        e instanceof Parse.Error && e.code === Parse.Error.OBJECT_NOT_FOUND
          ? 'Wrong username or PIN.'
          : e instanceof Error
            ? e.message
            : 'Check your credentials, then try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-shell">
      <AuthSide />
      <section className="auth-panel">
        <div className="login-card">
          {/* Phones: with a logo, only the restaurant's logo and name show. */}
          {!appInfo.restaurantLogo && <BrandMark className="mobile-brand" />}
          {platform ? (
            <PlatformSignIn onSignedIn={setUser} />
          ) : signingUp ? (
            <SignUp
              trialDays={appInfo.trialDays || 0}
              onCancel={() => setSigningUp(false)}
              onDone={async (code, fullUsername, pin) => {
                rememberRestaurant(code);
                await chooseRestaurant(code);
                setSigningUp(false);
                setUser(await Parse.User.logIn(fullUsername, pin));
              }}
            />
          ) : appInfo.hosted && !appInfo.found ? (
            <FindRestaurant
              serverError={serverError}
              onFind={chooseRestaurant}
              onSignUp={() => setSigningUp(true)}
            />
          ) : (
            <>
              {/* The restaurant's logo (Settings), else the Relay mark, with the
                restaurant's name under it. */}
              <div
                className={`login-identity${appInfo.restaurantLogo ? '' : ' no-logo'}${
                  logoReady ? '' : ' loading'
                }`}
              >
                {appInfo.restaurantLogo ? (
                  <img src={appInfo.restaurantLogo} alt="" />
                ) : (
                  <RelayMark />
                )}
                <span>{appInfo.restaurantName || 'Shift access'}</span>
              </div>
              <h2>Welcome back.</h2>
              <p className="muted">Sign in with your username and PIN.</p>
              <form onSubmit={login}>
                <label>
                  Username
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. rider014"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  PIN or password
                  <div className="input-icon">
                    <LockKeyhole size={18} />
                    <input
                      type="password"
                      inputMode="numeric"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••"
                      autoComplete="current-password"
                    />
                  </div>
                </label>
                {error && <p className="form-error">{error}</p>}
                {serverError && (
                  <p className="form-error">
                    Can't reach the Relay server functions ({serverError}). Sign-in may still work,
                    but ask your administrator to check the Cloud Code deployment.
                  </p>
                )}
                <button className="primary-button" disabled={busy}>
                  {busy ? 'Please wait…' : 'Start shift'}
                  <ArrowRight size={19} />
                </button>
              </form>
              {GOOGLE_SIGN_IN && (
                <button className="google-button" onClick={() => startGoogleSignIn()}>
                  Continue with Google
                </button>
              )}
              {previewAvailable && (
                <button className="preview-button" onClick={startPreview}>
                  <Eye size={17} /> Preview rider workspace
                </button>
              )}
              {appInfo.hosted && (
                <button
                  className="preview-button"
                  onClick={() => {
                    setError('');
                    void chooseRestaurant('');
                  }}
                >
                  Not {appInfo.restaurantName}? Change restaurant
                </button>
              )}
              <p className="support-copy">Need access? Ask your restaurant administrator.</p>
            </>
          )}
          <a className="privacy-link" href="/privacy">
            Privacy and terms
          </a>
        </div>
      </section>
    </main>
  );
}

// Relay Hosted: the device does not know its restaurant yet.
function FindRestaurant({
  serverError,
  onFind,
  onSignUp,
}: {
  serverError: string;
  onFind: (code: string) => Promise<{ found?: boolean }>;
  onSignUp: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const find = async (event: React.FormEvent) => {
    event.preventDefault();
    const wanted = normaliseCode(code);
    if (wanted.length < 3) {
      setError('Type your restaurant’s code, as your owner gave it to you.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const info = await onFind(wanted);
      if (info.found === false) setError(`No restaurant uses the code “${wanted}”.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not look that up. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="login-identity no-logo">
        <RelayMark />
        <span>Relay</span>
      </div>
      <h2>Find your restaurant.</h2>
      <p className="muted">
        Type the restaurant code, or open your restaurant’s own link (relay…/r/your-code) once on
        this device.
      </p>
      <form onSubmit={find}>
        <label>
          Restaurant code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. mama-rose"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        {serverError && (
          <p className="form-error">
            Can’t reach the Relay server ({serverError}). Try again soon.
          </p>
        )}
        <button className="primary-button" disabled={busy}>
          {busy ? 'Looking…' : 'Continue'}
          <ArrowRight size={19} />
        </button>
      </form>
      <button className="preview-button" onClick={onSignUp}>
        New restaurant? Start a free trial
      </button>
    </>
  );
}

// Relay Hosted: a new restaurant and its owner's account, on a free trial.
function SignUp({
  trialDays,
  onCancel,
  onDone,
}: {
  trialDays: number;
  onCancel: () => void;
  onDone: (code: string, username: string, pin: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    restaurantName: '',
    code: '',
    ownerName: '',
    phone: '',
    username: '',
    pin: '',
    plan: '',
  });
  const offered = useOfferedPlans();
  const [codeEdited, setCodeEdited] = useState(false);
  const [codeState, setCodeState] = useState<{ code: string; free: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const code = codeEdited ? normaliseCode(form.code) : normaliseCode(form.restaurantName);
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  // Whether the code is free, checked shortly after typing stops.
  useEffect(() => {
    if (code.length < 3) {
      setCodeState(null);
      return;
    }
    const timer = window.setTimeout(() => {
      Parse.Cloud.run('checkRestaurantCode', { code })
        .then(setCodeState)
        .catch(() => setCodeState(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [code]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result: { code: string; username: string } = await Parse.Cloud.run('signUpRestaurant', {
        ...form,
        code,
        username: form.username.trim().toLowerCase(),
      });
      await onDone(result.code, result.username, form.pin);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the restaurant. Try again.');
      setBusy(false);
    }
  };

  return (
    <>
      <p className="eyebrow">New restaurant</p>
      <h2>Start your free trial.</h2>
      <p className="muted">
        {trialDays > 0 ? `${trialDays} days free, no payment now. ` : ''}You become the owner and
        add your riders and cashiers afterwards.
      </p>
      <form onSubmit={submit}>
        <label>
          Restaurant name
          <input value={form.restaurantName} onChange={set('restaurantName')} required />
        </label>
        <label>
          Restaurant code
          <input
            value={codeEdited ? form.code : code}
            onChange={(e) => {
              setCodeEdited(true);
              set('code')(e);
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          <span className="field-hint">
            {code.length < 3
              ? 'Letters, digits and dashes; staff use it to find you.'
              : codeState?.code === code
                ? codeState.free
                  ? `Free: your address will be /r/${code}`
                  : `“${code}” is taken. Choose another.`
                : `Your address will be /r/${code}`}
          </span>
        </label>
        <label>
          Your name
          <input value={form.ownerName} onChange={set('ownerName')} autoComplete="name" required />
        </label>
        <label>
          Your phone (for billing)
          <input
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            autoComplete="tel"
            placeholder="07…"
            required
          />
        </label>
        <label>
          Your username
          <input
            value={form.username}
            onChange={set('username')}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <label>
          Password (6 characters or more)
          <input
            type="password"
            value={form.pin}
            onChange={set('pin')}
            autoComplete="new-password"
            minLength={6}
            required
          />
        </label>
        {offered && offered.plans.length > 1 && (
          <label>
            Plan
            <select
              value={form.plan || offered.plans[0].key}
              onChange={(e) => setForm((f) => ({ ...f, plan: e.target.value }))}
            >
              {offered.plans.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name}: {formatMoney(plan.price, offered.currency)} a month ·{' '}
                  {planPoints(plan).slice(0, 3).join(', ')}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="field-hint">
          You can change the plan later under your subscription. By creating a restaurant you accept{' '}
          <a href="/terms" target="_blank" rel="noreferrer">
            Relay’s terms
          </a>
          .
        </p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy || codeState?.free === false}>
          {busy ? 'Creating…' : 'Create restaurant'}
          <ArrowRight size={19} />
        </button>
      </form>
      <button className="preview-button" onClick={onCancel}>
        Already have a restaurant? Sign in
      </button>
    </>
  );
}

// Relay's own staff: the platform console.
function PlatformSignIn({ onSignedIn }: { onSignedIn: (user: Parse.User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await Parse.User.logIn(username.trim().toLowerCase(), password));
    } catch (e) {
      setError(
        e instanceof Parse.Error && e.code === Parse.Error.OBJECT_NOT_FOUND
          ? 'Wrong username or password.'
          : e instanceof Error
            ? e.message
            : 'Could not sign in.',
      );
      setBusy(false);
    }
  };
  return (
    <>
      <p className="eyebrow">Relay platform</p>
      <h2>Staff sign-in.</h2>
      <p className="muted">For Relay’s own team. Restaurants sign in on the main page.</p>
      <form onSubmit={submit}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
          <ArrowRight size={19} />
        </button>
      </form>
    </>
  );
}
