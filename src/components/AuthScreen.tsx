import { useState } from 'react';
import { ArrowRight, Bike, Eye, LockKeyhole } from 'lucide-react';
import Parse from '../parse';
import { startGoogleSignIn } from '../lib/googleSignIn';
import { useSession } from '../lib/session';

export function AuthScreen() {
  const { setUser, startPreview, appInfo, previewAvailable, error: sessionError } = useSession();
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
        owner.set({ username: username.trim(), password, email: email.trim() });
        await owner.signUp();
        setUser(owner);
      } else setUser(await Parse.User.logIn(username.trim(), password));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check your credentials, then try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <div className="brand-mark">
          <Bike size={25} />
          <span>Relay</span>
        </div>
        <div className="story-copy">
          <p className="eyebrow">Restaurant delivery operations</p>
          <h1>
            From kitchen
            <br />
            to doorstep.
            <br />
            <em>Cash accounted.</em>
          </h1>
          <p>Orders, riders and every handover — connected in one fast operating system.</p>
        </div>
        <div className="story-metric">
          <strong>01</strong>
          <span>
            One clean chain of custody
            <br />
            for every cash order.
          </span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="login-card">
          <div className="mobile-brand">
            <Bike /> Relay
          </div>
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
