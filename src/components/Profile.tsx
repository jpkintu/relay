import { useState } from 'react';
import { Coffee, KeyRound, LogOut, Zap } from 'lucide-react';
import Parse from '../parse';
import { useSession } from '../lib/session';
import { initials } from '../lib/format';

// Change your own PIN (riders, cashiers) or password (owner). The server
// signs every device out, so the app signs straight back in with the new one.
export function ChangePin() {
  const { profile, setUser } = useSession();
  const isOwner = profile?.role === 'admin';
  const word = isOwner ? 'password' : 'PIN';
  const min = isOwner ? 8 : 4;
  const [open, setOpen] = useState(false);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const reset = () => {
    setOldPin('');
    setNewPin('');
    setAgain('');
    setError('');
  };

  const submit = async () => {
    if (!profile) return;
    if (newPin !== again) {
      setError(`The new ${word}s do not match`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('changeMyPin', { oldPin, newPin });
      const next = await Parse.User.logIn(profile.username, newPin);
      reset();
      setOpen(false);
      setDone(`${isOwner ? 'Password' : 'PIN'} changed. Other devices were signed out.`);
      setUser(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not change your ${word}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <div className="change-pin">
        {done && <p className="setup-notice">{done}</p>}
        <button
          type="button"
          className="setup-secondary"
          onClick={() => {
            setDone('');
            setOpen(true);
          }}
        >
          <KeyRound /> Change {word}
        </button>
      </div>
    );

  const inputMode = isOwner ? undefined : 'numeric';
  return (
    <form
      className="change-pin open"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Change your {word}</h3>
      <label className="setup-field">
        Current {word}
        <input
          type="password"
          inputMode={inputMode}
          autoComplete="current-password"
          value={oldPin}
          onChange={(e) => setOldPin(e.target.value)}
        />
      </label>
      <label className="setup-field">
        New {word} ({min}+ {isOwner ? 'characters' : 'digits'})
        <input
          type="password"
          inputMode={inputMode}
          autoComplete="new-password"
          value={newPin}
          onChange={(e) => setNewPin(e.target.value)}
        />
      </label>
      <label className="setup-field">
        New {word} again
        <input
          type="password"
          inputMode={inputMode}
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      {error && <p className="ops-error">{error}</p>}
      <div className="change-pin-actions">
        <button disabled={busy || !oldPin || newPin.length < min || !again}>
          {busy ? 'Saving…' : `Save new ${word}`}
        </button>
        <button
          type="button"
          className="setup-secondary"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// Rider: available for orders, or on a break.
export function AvailabilityToggle({ compact = false }: { compact?: boolean }) {
  const { profile, refresh, preview } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!profile || profile.role !== 'rider' || preview) return null;
  const available = profile.available !== false;
  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      await Parse.Cloud.run('setMyAvailability', { available: !available });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change your status');
    } finally {
      setBusy(false);
    }
  };
  if (compact && available) return null;
  return (
    <div className={`availability ${available ? 'on' : 'off'}`} role="status">
      <span>
        {available ? <Zap /> : <Coffee />}
        <b>{available ? 'Available for orders' : 'On a break'}</b>
        <small>
          {available
            ? 'Take a break to pause new orders.'
            : 'New orders are paused until you are back.'}
        </small>
      </span>
      <button disabled={busy} onClick={() => void toggle()}>
        {available ? 'Take a break' : "I'm back"}
      </button>
      {error && <p className="ops-error">{error}</p>}
    </div>
  );
}

// Cashier: who is signed in, their shift, PIN change and sign out.
export function CashierProfile() {
  const { profile, logout, preview } = useSession();
  return (
    <div className="ops-content">
      <div className="profile-card cashier-profile">
        <div className="profile-avatar">{initials(profile?.name || 'Cashier')}</div>
        <h2>{profile?.name || 'Preview cashier'}</h2>
        {profile ? (
          <p>
            {profile.code && `${profile.code} · `}@{profile.username}
            {profile.phone && ` · ${profile.phone}`}
            {profile.role === 'admin' && ' · Owner'}
          </p>
        ) : (
          <p>Account details are available after signing in.</p>
        )}
        {!preview && profile && <ChangePin />}
        <button className="profile-logout" onClick={() => void logout()}>
          <LogOut /> {preview ? 'Leave preview' : 'Log out'}
        </button>
      </div>
    </div>
  );
}
