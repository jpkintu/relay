import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { LockKeyhole } from 'lucide-react';

// Sensitive steps (handing over cash, ending a shift, paying from the till)
// ask for the PIN again. `withPin(title, action)` opens the prompt and runs
// `action(pin)`; a wrong PIN or any other error stays in the prompt so the
// person can try again or cancel. Resolves true when the action succeeded.
type WithPin = (
  title: string,
  action: (pin: string) => Promise<unknown>,
  detail?: string,
) => Promise<boolean>;

const PinContext = createContext<WithPin | null>(null);

type Request = {
  title: string;
  detail?: string;
  action: (pin: string) => Promise<unknown>;
  done: (ok: boolean) => void;
};

export function PinProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const withPin = useCallback<WithPin>(
    (title, action, detail) =>
      new Promise((resolve) => {
        setPin('');
        setError('');
        setRequest({ title, detail, action, done: resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    request?.done(ok);
    setRequest(null);
    setPin('');
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !pin || busy) return;
    setBusy(true);
    setError('');
    try {
      await request.action(pin);
      close(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
      setPin('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PinContext.Provider value={withPin}>
      {children}
      {request && (
        <div className="cash-modal-backdrop">
          <form
            className="cash-modal pin-modal"
            role="dialog"
            aria-modal="true"
            aria-label={request.title}
            onSubmit={submit}
          >
            <LockKeyhole className="pin-icon" aria-hidden />
            <h2>{request.title}</h2>
            <p className="muted">{request.detail || 'Enter your PIN to confirm.'}</p>
            <label className="setup-field">
              Your PIN
              <input
                ref={input}
                autoFocus
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••"
              />
            </label>
            {error && (
              <p className="ops-error" role="alert">
                {error}
              </p>
            )}
            <div className="cash-modal-actions">
              <button type="submit" disabled={!pin || busy}>
                {busy ? 'Checking…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => close(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </PinContext.Provider>
  );
}

// Outside the provider (demo mode) the action runs without a PIN.
const noPin: WithPin = async (_title, action) => {
  await action('');
  return true;
};

export function usePin(): WithPin {
  return useContext(PinContext) ?? noPin;
}
