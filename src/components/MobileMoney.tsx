import { useState } from 'react';
import { Copy, Send } from 'lucide-react';
import { useConfig, useMoney } from '../lib/session';

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
}: {
  provider: string;
  reference: string;
  amount: number;
  customerPhone?: string;
  onProvider: (provider: string) => void;
  onReference: (reference: string) => void;
}) {
  const { mobileMoney = [], restaurantName } = useConfig();
  const money = useMoney();
  const [copied, setCopied] = useState(false);
  const account = mobileMoney.find((a) => a.provider === provider);

  if (!mobileMoney.length)
    return (
      <p className="ops-error full-row">
        Mobile money is not set up yet. Ask the owner to add the Airtel and MTN merchant codes in
        Settings.
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
      {account && (
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
  provider === 'mtn' ? 'MTN MoMo' : provider === 'airtel' ? 'Airtel Money' : provider;

export const referenceProblem = (reference: string) =>
  /^[A-Z0-9.-]{4,40}$/.test(reference.replace(/\s+/g, '').toUpperCase())
    ? ''
    : 'the transaction ID';
