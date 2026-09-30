import { useEffect, useState } from 'react';
import Parse from '../parse';
import { CheckCircle2, Copy, Loader2, Send, XCircle } from 'lucide-react';
import { useConfig, useMoney, type MerchantAccount } from '../lib/session';

// True when this payment is sent as a request to the customer's phone:
// automatic payments are on for the provider and the person did not choose
// the manual way (merchant code + transaction ID + cashier's check).
export const usesRequest = (
  accounts: MerchantAccount[] | undefined,
  provider: string,
  manual?: boolean,
) => !manual && !!accounts?.find((account) => account.provider === provider)?.auto;

// A number the request can go to (the server checks it properly).
export const payerPhoneProblem = (phone?: string) =>
  (phone || '').replace(/[^\d]/g, '').length >= 9 ? '' : 'the customer’s mobile money number';

// Provider choice, the restaurant's merchant code to share with the
// customer, and the transaction ID the rider types from the customer's
// payment message.
export function MobileMoneyPanel({
  provider,
  reference,
  amount,
  customerPhone,
  onProvider,
  onReference,
  manual,
  onManual,
  payerPhone,
  onPayerPhone,
}: {
  provider: string;
  reference: string;
  amount: number;
  customerPhone?: string;
  onProvider: (provider: string) => void;
  onReference: (reference: string) => void;
  // Automatic payments: the person may still choose the manual way.
  manual?: boolean;
  onManual?: (manual: boolean) => void;
  payerPhone?: string;
  onPayerPhone?: (phone: string) => void;
}) {
  const { mobileMoney = [], restaurantName } = useConfig();
  const money = useMoney();
  const [copied, setCopied] = useState(false);
  const account = mobileMoney.find((a) => a.provider === provider);
  const request = !!onManual && usesRequest(mobileMoney, provider, manual);

  if (!mobileMoney.length)
    return (
      <p className="ops-error full-row">
        Mobile money is not set up yet. The owner adds the Airtel and MTN merchant codes in Admin →
        Settings → Mobile money merchant codes.
      </p>
    );

  const message = account
    ? `Please pay ${money(amount)} to ${account.label} merchant code ${account.code}` +
      `${account.name ? ` (${account.name})` : ''} for your ${restaurantName} order, ` +
      'then send me the transaction ID from your confirmation message.'
    : '';
  const digits = (customerPhone || '').replace(/[^\d]/g, '').replace(/^0/, '256');
  const whatsapp = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;

  return (
    <div className="momo-panel full-row">
      <div className="channel-row">
        <span>Pay with</span>
        {mobileMoney.map((a) => (
          <button
            key={a.provider}
            className={provider === a.provider ? `active momo-${a.provider}` : `momo-${a.provider}`}
            onClick={() => onProvider(a.provider)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {account?.auto && onManual && (
        <div className="filter-toggle momo-mode" role="group" aria-label="How the customer pays">
          <button type="button" className={request ? 'active' : ''} onClick={() => onManual(false)}>
            Send a request to their phone
          </button>
          <button type="button" className={request ? '' : 'active'} onClick={() => onManual(true)}>
            They paid the merchant code
          </button>
        </div>
      )}
      {account && request && (
        <div className="momo-request">
          <label>
            <span>Customer’s {account.label} number</span>
            <input
              value={payerPhone ?? customerPhone ?? ''}
              onChange={(e) => onPayerPhone?.(e.target.value)}
              inputMode="tel"
              placeholder="07…"
            />
          </label>
          <p className="muted small">
            The customer gets a prompt on their phone for {money(amount)} and approves it with their{' '}
            {account.label} PIN. The payment confirms itself; nobody has to check it.
          </p>
        </div>
      )}
      {account && !request && !account.code && (
        <p className="muted small">
          No {account.label} merchant code is set, so the customer cannot pay one. Send a request to
          their phone instead.
        </p>
      )}
      {account && !request && account.code && (
        <>
          <div className={`merchant-card momo-${account.provider}`}>
            <small>{account.label} merchant code</small>
            <strong>{account.code}</strong>
            <span>
              {account.name || restaurantName} · {money(amount)}
            </span>
          </div>
          <div className="merchant-actions">
            <a className="setup-secondary" href={whatsapp} target="_blank" rel="noreferrer">
              <Send size={15} /> Share on WhatsApp
            </a>
            <button
              type="button"
              className="setup-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(message);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                } catch {
                  // Clipboard blocked: the code is on screen to read out.
                }
              }}
            >
              <Copy size={15} /> {copied ? 'Copied' : 'Copy message'}
            </button>
          </div>
          <label>
            <span>Transaction ID (from the customer’s payment message)</span>
            <input
              value={reference}
              onChange={(e) => onReference(e.target.value)}
              placeholder="e.g. 8123456789"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      )}
    </div>
  );
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING_VERIFICATION: 'Waiting for cashier to confirm',
  VERIFIED: 'Payment confirmed',
  REJECTED: 'Payment not received',
};

export const providerLabel = (provider: string) =>
  provider === 'mtn'
    ? 'MTN MoMo'
    : provider === 'airtel'
      ? 'Airtel Money'
      : provider === 'card'
        ? 'Card'
        : provider;

export const referenceProblem = (reference: string) =>
  /^[A-Z0-9.-]{4,40}$/.test(reference.replace(/\s+/g, '').toUpperCase())
    ? ''
    : 'the transaction ID';

type RequestState = {
  payRequestStatus: string;
  paymentStatus: string;
  reason: string;
  reference: string;
};

// A payment request on its way: asks the server every few seconds (which asks
// MTN / Airtel) until the customer approves or declines. `onSettled` runs once.
export function PaymentRequestStatus({
  orderId,
  onSettled,
}: {
  orderId: string;
  onSettled?: (state: RequestState) => void;
}) {
  const [state, setState] = useState<RequestState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const ask = async () => {
      try {
        const next: RequestState = await Parse.Cloud.run('checkPaymentRequest', { orderId });
        if (stopped) return;
        setState(next);
        setError('');
        if (['queued', 'pending'].includes(next.payRequestStatus))
          timer = window.setTimeout(ask, 4000);
        else onSettled?.(next);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : 'Could not check');
        timer = window.setTimeout(ask, 8000);
      }
    };
    void ask();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
  const waiting = !state || ['queued', 'pending'].includes(state.payRequestStatus);
  const paid = state?.paymentStatus === 'VERIFIED';
  return (
    <div className={`pay-request ${waiting ? 'waiting' : paid ? 'good' : 'bad'}`} role="status">
      {waiting ? (
        <Loader2 aria-hidden className="spin" />
      ) : paid ? (
        <CheckCircle2 aria-hidden />
      ) : (
        <XCircle aria-hidden />
      )}
      <span>
        {waiting
          ? 'Waiting for the customer to approve the payment on their phone…'
          : paid
            ? `Payment received${state?.reference ? ` · ${state.reference}` : ''}.`
            : `Payment not received: ${state?.reason || 'the request did not go through'}.`}
        {error && <small> ({error})</small>}
      </span>
    </div>
  );
}
