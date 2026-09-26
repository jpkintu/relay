import { useState } from 'react';
import { ArrowRight, Eye, LockKeyhole } from 'lucide-react';
import Parse from '../parse';
import { startGoogleSignIn } from '../lib/googleSignIn';
import { useSession } from '../lib/session';
import { BrandMark } from './BrandMark';

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
    error: sessionError,
  } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(sessionError);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      if (creating) {
        const owner = new Parse.User();
        owner.set({ username: username.trim().toLowerCase(), password, email: email.trim() });
        await owner.signUp();
        setUser(owner);
      } else setUser(await logIn(username, password));
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
      <section className="auth-story">
        <BrandMark onDark />
        <div className="story-copy">
          <h1>
            From kitchen
            <br />
            to doorstep.
            <br />
            <em>Cash accounted.</em>
          </h1>
          <p>Orders, riders and every handover — connected in one fast operating system.</p>
        </div>
      </section>
      <section className="auth-panel">
        <div className="login-card">
          <BrandMark className="mobile-brand" />
          <p className="eyebrow">
            {creating ? 'Restaurant setup' : appInfo.restaurantName || 'Shift access'}
          </p>
          <h2>{creating ? 'Create owner account.' : 'Welcome back.'}</h2>
          <p className="muted">
            {creating
              ? 'For the first restaurant owner only. Verify your email after registration.'
              : 'Riders and cashiers sign in with their username and PIN.'}
          </p>
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
            {creating && (
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="owner@restaurant.com"
                />
              </label>
            )}
            {error && <p className="form-error">{error}</p>}
            {serverError && (
              <p className="form-error">
                Can't reach the Relay server functions ({serverError}). Sign-in may still work, but
                ask your administrator to check the Cloud Code deployment.
              </p>
            )}
            <button className="primary-button" disabled={busy}>
              {busy ? 'Please wait…' : creating ? 'Create account' : 'Start shift'}
              <ArrowRight size={19} />
            </button>
          </form>
          <button className="google-button" onClick={() => startGoogleSignIn()}>
            Continue with Google
          </button>
          {previewAvailable && (
            <button className="preview-button" onClick={startPreview}>
              <Eye size={17} /> Preview rider workspace
            </button>
          )}
          {(appInfo.ownerSetupOpen || creating) && (
            <button
              className="preview-button"
              onClick={() => {
                setCreating((p) => !p);
                setError('');
              }}
            >
              {creating ? 'Already have an account? Sign in' : 'First owner? Create account'}
            </button>
          )}
          <p className="support-copy">Need access? Ask your restaurant administrator.</p>
        </div>
      </section>
    </main>
  );
}
