import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import Parse from '../parse';
import { formatMoney } from '../lib/format';

// Relay Hosted, platform console: the plans restaurants subscribe to. Each
// plan's price, how many branches and team members of each role it allows,
// and which parts of the app it includes (cloud/lib/plans.js). Changes apply
// to every restaurant on the plan straight away; what a restaurant already
// has is kept, only additions are limited.

export type Plan = {
  id: string;
  key: string;
  name: string;
  description: string;
  price: number;
  active: boolean;
  sortOrder: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  restaurants?: number;
};

export const FEATURE_NAMES: Record<string, string> = {
  branches: 'Several branches',
  finance: 'Finance role',
  accounting: 'Purchases, expenses & accounting',
  reports: 'Reports & analytics',
  efris: 'EFRIS tax receipts',
  whatsapp: 'WhatsApp daily summaries',
};
export const LIMIT_NAMES: Record<string, string> = {
  branches: 'Branches',
  cashier: 'Cashiers',
  rider: 'Riders',
  finance: 'Finance staff',
};

const limitText = (value: number | null) => (value === null ? 'No limit' : String(value));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Draft = {
  id?: string;
  name: string;
  description: string;
  price: string;
  active: boolean;
  limits: Record<string, string>;
  features: Record<string, boolean>;
};

const draftOf = (plan: Plan | null, features: string[], limits: string[]): Draft => ({
  id: plan?.id,
  name: plan?.name || '',
  description: plan?.description || '',
  price: plan ? String(plan.price) : '',
  active: plan ? plan.active : true,
  limits: Object.fromEntries(
    limits.map((k) => [k, plan?.limits[k] === null || !plan ? '' : String(plan.limits[k])]),
  ),
  features: Object.fromEntries(features.map((f) => [f, plan ? plan.features[f] === true : true])),
});

export function PlatformPlans({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{
    currency: string;
    features: string[];
    limits: string[];
    plans: Plan[];
  } | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await Parse.Cloud.run('platformListPlans'));
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setSaveError('');
    try {
      await Parse.Cloud.run('platformSavePlan', {
        ...(draft.id && { id: draft.id }),
        name: draft.name,
        description: draft.description,
        price: Number(draft.price),
        active: draft.active,
        limits: Object.fromEntries(
          Object.entries(draft.limits).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)]),
        ),
        features: draft.features,
      });
      setDraft(null);
      await load();
      onChanged();
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="ops-error">{error}</p>;
  if (!data) return null;
  return (
    <section className="admin-panel">
      <div className="panel-title">
        <div>
          <h2>Plans</h2>
          <p className="muted">
            What each plan costs, its limits and the parts of the app it includes. A change applies
            to every restaurant on the plan at once; what they already have is kept. A restaurant
            can also have its own negotiated price.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => {
            setSaveError('');
            setDraft(draftOf(null, data.features, data.limits));
          }}
        >
          <Plus size={16} /> New plan
        </button>
      </div>
      <div className="table-scroll">
        <table className="data plan-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th className="num">Price a month</th>
              {data.limits.map((k) => (
                <th key={k} className="num">
                  {LIMIT_NAMES[k] || k}
                </th>
              ))}
              {data.features.map((f) => (
                <th key={f} className="feature-col">
                  {FEATURE_NAMES[f] || f}
                </th>
              ))}
              <th className="num">Restaurants</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.plans.map((plan) => (
              <tr key={plan.id} className={plan.active ? '' : 'inactive'}>
                <td>
                  <b>{plan.name}</b>
                  <small className="cell-sub">
                    {plan.active ? 'On offer' : 'Not offered'}
                    {plan.description && ` · ${plan.description}`}
                  </small>
                </td>
                <td className="num">{formatMoney(plan.price, data.currency)}</td>
                {data.limits.map((k) => (
                  <td key={k} className="num">
                    {limitText(plan.limits[k])}
                  </td>
                ))}
                {data.features.map((f) => (
                  <td key={f} className="feature-col">
                    {plan.features[f] ? (
                      <Check size={16} aria-label="Included" className="good-text" />
                    ) : (
                      <Minus size={16} aria-label="Not included" className="muted" />
                    )}
                  </td>
                ))}
                <td className="num">{plan.restaurants ?? 0}</td>
                <td>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setSaveError('');
                      setDraft(draftOf(plan, data.features, data.limits));
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {draft && (
        <form className="platform-form plan-form" onSubmit={(e) => void save(e)}>
          <h3>{draft.id ? `Edit ${draft.name}` : 'New plan'}</h3>
          <label className="setup-field">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={40}
            />
          </label>
          <label className="setup-field">
            Price a month ({data.currency})
            <input
              inputMode="numeric"
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/[^\d]/g, '') })}
            />
          </label>
          <label className="setup-field platform-note">
            Description (shown to restaurants)
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={160}
            />
          </label>
          {data.limits.map((k) => (
            <label className="setup-field" key={k}>
              {LIMIT_NAMES[k] || k}
              <input
                inputMode="numeric"
                value={draft.limits[k]}
                placeholder="No limit"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    limits: { ...draft.limits, [k]: e.target.value.replace(/[^\d]/g, '') },
                  })
                }
              />
            </label>
          ))}
          <fieldset className="platform-note plan-features">
            <legend>Parts of the app included</legend>
            {data.features.map((f) => (
              <label className="setup-checkbox" key={f}>
                <input
                  type="checkbox"
                  checked={draft.features[f]}
                  onChange={(e) =>
                    setDraft({ ...draft, features: { ...draft.features, [f]: e.target.checked } })
                  }
                />{' '}
                {FEATURE_NAMES[f] || f}
              </label>
            ))}
          </fieldset>
          <label className="setup-checkbox platform-note">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />{' '}
            On offer (at sign-up and when owners change plan). Restaurants already on it stay.
          </label>
          {saveError && <p className="form-error platform-note">{saveError}</p>}
          <div className="payment-actions platform-note">
            <button disabled={busy || draft.name.trim().length < 2 || draft.price === ''}>
              {draft.id ? 'Save plan' : 'Create plan'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
