import { useEffect, useState } from 'react';
import { ArrowRight, Eye, LockKeyhole } from 'lucide-react';
import Parse from '../parse';
import { startGoogleSignIn } from '../lib/googleSignIn';

// Google sign-in is off (owner's decision 2026-09-28): staff sign in with a
// username and PIN. Build with VITE_ENABLE_GOOGLE_SIGNIN=true to show it again.
const GOOGLE_SIGN_IN = import.meta.env.VITE_ENABLE_GOOGLE_SIGNIN === 'true';
import { useSession } from '../lib/session';
import { formatMoney } from '../lib/format';
import { AuthSide } from './AuthSide';
import { BrandMark } from './BrandMark';
import { PlanCard, useOfferedPlans } from './Subscription';
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
  // A referral link (/?ref=code) opens the sign-up page with the code.
  const [referral] = useState(
    () => new URLSearchParams(window.location.search).get('ref')?.trim() || '',
  );
  const [signingUp, setSigningUp] = useState(!!referral);
  // Relay Hosted: the owner's forgotten password (a link is emailed to them).
  const [forgot, setForgot] = useState(false);
  const [resetToken, setResetToken] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('reset') || '',
  );
  const [notice, setNotice] = useState('');
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
    // Sign-up takes the whole screen: the form, the plans and how to start.
    <main className={`auth-shell${signingUp && !platform ? ' auth-full' : ''}`}>
      {!(signingUp && !platform) && <AuthSide />}
      <section className="auth-panel">
        <div className={`login-card${signingUp && !platform ? ' signup-card' : ''}`}>
          {/* Phones: with a logo, only the restaurant's logo and name show. */}
          {!appInfo.restaurantLogo && <BrandMark className="mobile-brand" />}
          {platform ? (
            <PlatformSignIn onSignedIn={setUser} />
          ) : resetToken ? (
            <ResetPassword
              token={resetToken}
              onDone={async (code, name) => {
                window.history.replaceState(null, '', '/');
                setResetToken('');
                rememberRestaurant(code);
                await chooseRestaurant(code);
                setUsername(name);
                setNotice('Password changed. Sign in with your new password.');
              }}
              onCancel={() => {
                window.history.replaceState(null, '', '/');
                setResetToken('');
              }}
            />
          ) : forgot && restaurantCode ? (
            <ForgotPassword
              code={restaurantCode}
              restaurantName={appInfo.restaurantName}
              onBack={() => setForgot(false)}
            />
          ) : signingUp ? (
            <SignUp
              trialDays={appInfo.trialDays || 0}
              initialCode={referral}
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
                {notice && <p className="form-success">{notice}</p>}
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
              {appInfo.hosted && restaurantCode && (
                <button
                  className="link-button forgot-link"
                  onClick={() => {
                    setError('');
                    setNotice('');
                    setForgot(true);
                  }}
                >
                  Owner? Forgot your password
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

// Relay Hosted: a new restaurant and its owner's account, on a free trial or
// paying now (then with an optional discount or referral code).
type CodeCheck = {
  code: string;
  type: 'code' | 'referral';
  label: string;
  referrerName: string;
  currency: string;
  prices: Record<number, { list: number; discount: number; amount: number }>;
};
function SignUp({
  trialDays,
  initialCode = '',
  onCancel,
  onDone,
}: {
  trialDays: number;
  initialCode?: string;
  onCancel: () => void;
  onDone: (code: string, username: string, pin: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    restaurantName: '',
    code: '',
    ownerName: '',
    phone: '',
    email: '',
    username: '',
    pin: '',
    plan: '',
  });
  const offered = useOfferedPlans();
  const [start, setStart] = useState<'trial' | 'pay'>(
    trialDays > 0 && !initialCode ? 'trial' : 'pay',
  );
  const [offerCode, setOfferCode] = useState(initialCode);
  const [offerCheck, setOfferCheck] = useState<CodeCheck | null>(null);
  const [offerError, setOfferError] = useState('');
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

  const plan = form.plan || offered?.plans[0]?.key || '';
  const applyCode = async () => {
    setOfferError('');
    setOfferCheck(null);
    try {
      setOfferCheck(await Parse.Cloud.run('checkSignupCode', { code: offerCode, plan }));
    } catch (e) {
      setOfferError(e instanceof Error ? e.message : 'This code is not valid');
    }
  };
  // The applied code's prices follow the chosen plan (and a referral link's
  // code is applied once the plans are in).
  useEffect(() => {
    if ((offerCheck || (initialCode && !offerError)) && plan) void applyCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result: { code: string; username: string } = await Parse.Cloud.run('signUpRestaurant', {
        ...form,
        code,
        username: form.username.trim().toLowerCase(),
        start,
        offerCode: start === 'pay' ? offerCode.trim() : '',
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
      <h2>{start === 'trial' ? 'Start your free trial.' : 'Pay now and start today.'}</h2>
      <p className="muted">
        {start === 'trial'
          ? `${trialDays} days free, no payment now. `
          : 'Pay your first period right after sign-up, with a discount or referral code if you have one. '}
        You become the owner and add your riders and cashiers afterwards.
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
          Your email
          <input
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            required
          />
          <span className="field-hint">For password resets and emails from Relay.</span>
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
        {offered && offered.plans.length > 0 && (
          <fieldset className="signup-plans">
            <legend>Choose your plan</legend>
            <div className="plan-picker" role="radiogroup" aria-label="Plan">
              {offered.plans.map((plan) => (
                <PlanCard
                  key={plan.key}
                  plan={plan}
                  currency={offered.currency}
                  current={(form.plan || offered.plans[0].key) === plan.key}
                  badge="Chosen"
                  onSelect={() => setForm((f) => ({ ...f, plan: plan.key }))}
                />
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="signup-start">
          <legend>How do you want to start?</legend>
          <div className="filter-toggle" role="radiogroup" aria-label="How to start">
            {trialDays > 0 && (
              <button
                type="button"
                role="radio"
                aria-checked={start === 'trial'}
                className={start === 'trial' ? 'active' : ''}
                onClick={() => setStart('trial')}
              >
                {trialDays}-day free trial
              </button>
            )}
            <button
              type="button"
              role="radio"
              aria-checked={start === 'pay'}
              className={start === 'pay' ? 'active' : ''}
              onClick={() => setStart('pay')}
            >
              Pay now
            </button>
          </div>
          {start === 'pay' ? (
            <div className="signup-code">
              <label>
                Discount or referral code (optional)
                <span className="signup-code-row">
                  <input
                    value={offerCode}
                    onChange={(e) => {
                      setOfferCode(e.target.value);
                      setOfferCheck(null);
                      setOfferError('');
                    }}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="e.g. LAUNCH20 or a restaurant’s code"
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!offerCode.trim()}
                    onClick={() => void applyCode()}
                  >
                    Apply
                  </button>
                </span>
              </label>
              {offerError && <p className="form-error">{offerError}</p>}
              {offerCheck && (
                <p className="form-success" role="status">
                  <b>{offerCheck.code}</b>
                  {offerCheck.referrerName ? ` (referred by ${offerCheck.referrerName})` : ''}:{' '}
                  {offerCheck.label}. A month{' '}
                  {formatMoney(offerCheck.prices[1].amount, offerCheck.currency)}
                  {offerCheck.prices[1].discount
                    ? ` instead of ${formatMoney(offerCheck.prices[1].list, offerCheck.currency)}`
                    : ''}
                  ; a year {formatMoney(offerCheck.prices[12].amount, offerCheck.currency)}.
                </p>
              )}
              <span className="field-hint">
                Codes only apply when paying now, on your first payment. The app opens as soon as it
                is paid.
              </span>
            </div>
          ) : (
            <span className="field-hint">
              Nothing to pay now. Codes are for paying now; a trial cannot use one.
            </span>
          )}
        </fieldset>
        <p className="field-hint">
          You can change the plan later under your subscription. By creating a restaurant you accept{' '}
          <a href="/terms" target="_blank" rel="noreferrer">
            Relay’s terms
          </a>
          .
        </p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy || codeState?.free === false}>
          {busy ? 'Creating…' : start === 'pay' ? 'Create and pay' : 'Create restaurant'}
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

// Relay Hosted: the owner asks for a password reset link by email.
function ForgotPassword({
  code,
  restaurantName,
  onBack,
}: {
  code: string;
  restaurantName: string;
  onBack: () => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('requestOwnerReset', { code, email });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the link. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>Forgot your password?</h2>
      <p className="muted">
        Owners of {restaurantName || 'this restaurant'}: enter the email you signed up with and we
        will send you a link to choose a new password. Riders and cashiers: ask your owner to reset
        your PIN.
      </p>
      {sent ? (
        <p className="form-success">
          If that email belongs to this restaurant&apos;s owner, a link is on its way. It works for
          one hour. Check your spam folder too.
        </p>
      ) : (
        <form onSubmit={submit}>
          <label>
            Your email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              required
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Email me a link'}
            <ArrowRight size={19} />
          </button>
        </form>
      )}
      <button className="preview-button" onClick={onBack}>
        Back to sign in
      </button>
    </>
  );
}

// Relay Hosted: the emailed link (/?reset=…) sets a new owner password.
function ResetPassword({
  token,
  onDone,
  onCancel,
}: {
  token: string;
  onDone: (code: string, username: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result: { code: string; username: string } = await Parse.Cloud.run(
        'completeOwnerReset',
        { token, password },
      );
      await onDone(result.code, result.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the password.');
      setBusy(false);
    }
  };
  return (
    <>
      <h2>Choose a new password.</h2>
      <p className="muted">At least 6 characters. You are signed out on every device.</p>
      <form onSubmit={submit}>
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          The same again
          <input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy || password.length < 6}>
          {busy ? 'Saving…' : 'Save new password'}
          <ArrowRight size={19} />
        </button>
      </form>
      <button className="preview-button" onClick={onCancel}>
        Back to sign in
      </button>
    </>
  );
}
