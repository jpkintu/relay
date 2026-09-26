import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import Parse from '../parse';
import { useMoney, useSession } from '../lib/session';
import { ChangePin } from './Profile';

type Member = {
  id: string;
  name: string;
  username: string;
  phone: string;
  role: string;
  code: string;
  active: boolean;
  commissionType: string;
  commissionPerOrder: number;
  commissionPercent: number;
  available: boolean | null;
  onShift: boolean;
  cashHeld: number;
  cashLimit: number | null;
};
type Item = {
  id: string;
  title: string;
  price: number;
  category: string;
  active: boolean;
  availableToday: boolean;
  accompanimentGroups: Group[];
};
type Group = { label: string; options: string[]; min: number; max: number };
type Accompaniment = { id: string; title: string; active: boolean; available: boolean };
type Category = { id: string; title: string; active: boolean };
type Settings = {
  restaurantName: string;
  currencySymbol: string;
  currencyCode: string;
  timezone: string;
  defaultDeliveryFee: number;
  maxRiderFloat: number;
  allowBatching: boolean;
  requireCashierConfirmForPickup?: boolean;
  airtelMerchantCode?: string;
  airtelMerchantName?: string;
  mtnMerchantCode?: string;
  mtnMerchantName?: string;
  cashReminderHour?: number;
  floatWarningPercent?: number;
  commissionRounding?: string;
  defaultCommissionType?: string;
  defaultCommissionPerOrder?: number;
  defaultCommissionPercent?: number;
};
const input = (
  label: string,
  value: string | number,
  onChange: (value: string) => void,
  type = 'text',
) => (
  <label className="setup-field">
    {label}
    <input
      required
      value={value}
      type={type}
      min={type === 'number' ? 0 : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  </label>
);

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export function AdminSetup({
  section,
  preview,
}: {
  section: 'Team' | 'Menu' | 'Settings';
  preview: boolean;
}) {
  const { config, refresh } = useSession();
  const money = useMoney();
  const navigate = useNavigate();
  const [team, setTeam] = useState<Member[]>([]),
    [menu, setMenu] = useState<Item[]>([]),
    [accompaniments, setAccompaniments] = useState<Accompaniment[]>([]),
    [itemGroups, setItemGroups] = useState<Group[]>([]),
    [accompanimentTitle, setAccompanimentTitle] = useState(''),
    [categories, setCategories] = useState<Category[]>([]),
    [settings, setSettings] = useState<Settings>(config);
  const [name, setName] = useState(''),
    [username, setUsername] = useState(''),
    [phone, setPhone] = useState(''),
    [pin, setPin] = useState(''),
    [role, setRole] = useState('rider');
  const [itemTitle, setItemTitle] = useState(''),
    [itemPrice, setItemPrice] = useState(''),
    [itemCategory, setItemCategory] = useState('Mains'),
    [editingItem, setEditingItem] = useState<string | null>(null),
    [categoryTitle, setCategoryTitle] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    if (preview) return;
    try {
      const data = await Parse.Cloud.run('adminListSetup');
      setTeam(data.team);
      setMenu(data.menu);
      setAccompaniments(data.accompaniments || []);
      setCategories(data.categories || []);
      if (data.settings) setSettings((current) => ({ ...current, ...data.settings }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load setup');
    }
  }, [preview]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (fn: string, payload: Record<string, unknown>, after: () => void) => {
    if (preview) {
      setError('Sign in as an owner to change operational data.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await Parse.Cloud.run(fn, payload);
      after();
      await load();
      setNotice('Saved to the restaurant database.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-page">
      {error && <p className="ops-error">{error}</p>}
      {notice && <p className="setup-notice">{notice}</p>}
      {preview && (
        <p className="setup-notice">
          Live setup is available to signed-in owners. Preview is read-only.
        </p>
      )}
      {section === 'Team' && (
        <>
          <div className="admin-panel">
            <div className="panel-title">
              <div>
                <h2>Create rider or cashier</h2>
              </div>
            </div>
            <form
              className="setup-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save('adminCreateTeamMember', { name, username, phone, pin, role }, () => {
                  setName('');
                  setUsername('');
                  setPhone('');
                  setPin('');
                });
              }}
            >
              {input('Full name', name, setName)}
              {input('Username', username, setUsername)}
              {input('Phone', phone, setPhone)}
              {input('PIN (4+ digits)', pin, setPin, 'password')}
              <label className="setup-field">
                Role
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="rider">Rider</option>
                  <option value="cashier">Cashier</option>
                </select>
              </label>
              <button disabled={busy || preview} className="setup-submit">
                Create team member
              </button>
            </form>
          </div>
          <section className="admin-panel admin-section-panel">
            <div className="panel-title">
              <h2>
                Team members <small>({team.length})</small>
              </h2>
            </div>
            <p className="muted small">
              Open someone to see their cash, orders and history, change their pay or cash limit,
              reset a forgotten PIN or deactivate them.
            </p>
            {team.length ? (
              <div className="table-scroll">
                <table className="data stack-on-phone team-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th className="num">Cash held</th>
                      <th>Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((u) => (
                      <tr key={u.id} className={u.active ? '' : 'inactive'}>
                        <td data-label="Name">
                          <b>{u.name}</b>
                          <small>
                            {u.code && `${u.code} · `}@{u.username}
                          </small>
                        </td>
                        <td data-label="Role">{u.role === 'admin' ? 'Owner' : capital(u.role)}</td>
                        <td data-label="Status">
                          <span className="team-status">
                            {!u.active ? (
                              <span className="status-pill bad">Deactivated</span>
                            ) : (
                              <>
                                <span className={`status-pill ${u.onShift ? 'good' : ''}`}>
                                  {u.onShift ? 'On shift' : 'Off shift'}
                                </span>
                                {u.available === false && (
                                  <span className="status-pill">On a break</span>
                                )}
                              </>
                            )}
                          </span>
                        </td>
                        <td data-label="Cash held" className="num">
                          {u.role === 'rider' ? (
                            <>
                              {money(u.cashHeld)}
                              {u.cashLimit !== null && (
                                <small>own limit {money(u.cashLimit)}</small>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Page" className="actions-cell">
                          <div className="payment-actions">
                            <button
                              className="setup-secondary"
                              disabled={preview}
                              onClick={() => navigate(`/admin/team/${u.id}`)}
                            >
                              Open <ChevronRight />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-orders">No team members loaded yet.</p>
            )}
          </section>
        </>
      )}
      {section === 'Menu' && (
        <>
          <div className="admin-panel">
            <h2>Categories</h2>
            <form
              className="category-create"
              onSubmit={(e) => {
                e.preventDefault();
                void save('adminSaveCategory', { title: categoryTitle }, () =>
                  setCategoryTitle(''),
                );
              }}
            >
              <input
                required
                placeholder="New category name"
                value={categoryTitle}
                onChange={(e) => setCategoryTitle(e.target.value)}
              />
              <button disabled={busy || preview}>Add category</button>
            </form>
            {categories.map((category) => (
              <CategoryEditor
                key={`${category.id}-${category.title}-${category.active}`}
                category={category}
                disabled={busy || preview}
                save={(payload) =>
                  save('adminSaveCategory', { id: category.id, ...payload }, () => {})
                }
              />
            ))}
          </div>
          <div className="admin-panel">
            <h2>Accompaniments</h2>
            <p className="muted">
              Add matooke, rice, pumpkin and so on here, then choose which ones each dish offers.
              Cashiers can mark them sold out from their Stock tab.
            </p>
            <form
              className="category-create"
              onSubmit={(e) => {
                e.preventDefault();
                void save('adminSaveAccompaniment', { title: accompanimentTitle }, () =>
                  setAccompanimentTitle(''),
                );
              }}
            >
              <input
                required
                placeholder="New accompaniment, e.g. Matooke"
                value={accompanimentTitle}
                onChange={(e) => setAccompanimentTitle(e.target.value)}
              />
              <button disabled={busy || preview}>Add accompaniment</button>
            </form>
            {accompaniments.map((a) => (
              <AccompanimentEditor
                key={`${a.id}-${a.title}-${a.active}-${a.available}`}
                accompaniment={a}
                disabled={busy || preview}
                save={(payload) => save('adminSaveAccompaniment', { ...a, ...payload }, () => {})}
              />
            ))}
          </div>
          <div className="admin-panel">
            <h2>{editingItem ? 'Edit menu item' : 'Add menu item'}</h2>
            <form
              className="setup-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save(
                  'adminSaveMenuItem',
                  {
                    id: editingItem || undefined,
                    title: itemTitle,
                    price: Number(itemPrice),
                    category: itemCategory,
                    accompanimentGroups: itemGroups,
                  },
                  () => {
                    setItemTitle('');
                    setItemPrice('');
                    setItemGroups([]);
                    setEditingItem(null);
                  },
                );
              }}
            >
              {input('Item name', itemTitle, setItemTitle)}
              {input('Price', itemPrice, setItemPrice, 'number')}
              <label className="setup-field">
                Category
                <select value={itemCategory} onChange={(e) => setItemCategory(e.target.value)}>
                  {(categories.length
                    ? categories.filter((c) => c.active).map((c) => c.title)
                    : ['Breakfast', 'Mains', 'Drinks', 'Sides', 'Desserts']
                  ).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <GroupsEditor
                groups={itemGroups}
                accompaniments={accompaniments.filter((a) => a.active)}
                onChange={setItemGroups}
              />
              <button className="setup-submit" disabled={busy || preview}>
                {editingItem ? 'Save item changes' : 'Add menu item'}
              </button>
              {editingItem && (
                <button
                  type="button"
                  className="setup-secondary"
                  onClick={() => {
                    setEditingItem(null);
                    setItemTitle('');
                    setItemPrice('');
                    setItemGroups([]);
                  }}
                >
                  Cancel editing
                </button>
              )}
            </form>
          </div>
          <div className="admin-panel">
            <h2>Menu items</h2>
            {menu.map((item) => (
              <div className="setup-row" key={item.id}>
                <div>
                  <b>{item.title}</b>
                  <small>
                    {item.category} · {money(item.price)}
                    {item.accompanimentGroups?.length > 0 &&
                      ` · ${item.accompanimentGroups.map((g) => g.label).join(', ')}`}
                  </small>
                </div>
                <span>{item.availableToday ? 'Available' : 'Unavailable'}</span>
                <button
                  disabled={busy || preview}
                  onClick={() => {
                    setEditingItem(item.id);
                    setItemTitle(item.title);
                    setItemPrice(String(item.price));
                    setItemCategory(item.category);
                    setItemGroups(item.accompanimentGroups || []);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Edit
                </button>
                <button
                  disabled={busy || preview}
                  onClick={() =>
                    void save(
                      'adminSaveMenuItem',
                      { ...item, availableToday: !item.availableToday },
                      () => {},
                    )
                  }
                >
                  {item.availableToday ? 'Hide today' : 'Make available'}
                </button>
              </div>
            ))}
            {!menu.length && <p className="empty-orders">No menu items saved yet.</p>}
          </div>
        </>
      )}
      {section === 'Settings' && (
        <div className="admin-panel">
          <h2>Operating settings</h2>
          <form
            className="setup-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save('adminSaveSettings', settings, () => void refresh());
            }}
          >
            {input('Restaurant name', settings.restaurantName, (v) =>
              setSettings((p) => ({ ...p, restaurantName: v })),
            )}
            {input('Currency symbol', settings.currencySymbol, (v) =>
              setSettings((p) => ({ ...p, currencySymbol: v })),
            )}
            {input('Currency code (ISO, e.g. UGX)', settings.currencyCode, (v) =>
              setSettings((p) => ({ ...p, currencyCode: v })),
            )}
            {input('Timezone (e.g. Africa/Kampala)', settings.timezone, (v) =>
              setSettings((p) => ({ ...p, timezone: v })),
            )}
            {input(
              'Default delivery fee',
              settings.defaultDeliveryFee,
              (v) => setSettings((p) => ({ ...p, defaultDeliveryFee: Number(v) })),
              'number',
            )}
            {input(
              'Rider cash limit (a rider can have their own)',
              settings.maxRiderFloat,
              (v) => setSettings((p) => ({ ...p, maxRiderFloat: Number(v) })),
              'number',
            )}
            {input(
              'Warn riders at (% of their cash limit)',
              settings.floatWarningPercent ?? 80,
              (v) => setSettings((p) => ({ ...p, floatWarningPercent: Number(v) })),
              'number',
            )}
            {input(
              'Cash handover reminder (hour, 0–23)',
              settings.cashReminderHour ?? 20,
              (v) => setSettings((p) => ({ ...p, cashReminderHour: Number(v) })),
              'number',
            )}
            <div className="full-row merchant-settings">
              <p className="setup-field-label">Rider commission</p>
              <p className="muted">
                The rule new riders start with; change any rider&apos;s own rule on their page in
                Team. Commission is on the food subtotal; riders also get the delivery fee.
              </p>
              <label className="setup-field">
                Rule for new riders
                <select
                  value={settings.defaultCommissionType ?? 'per_order'}
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, defaultCommissionType: e.target.value }))
                  }
                >
                  <option value="per_order">Fixed per order</option>
                  <option value="percent">Percent of subtotal</option>
                  <option value="hybrid">Fixed + percent</option>
                </select>
              </label>
              {settings.defaultCommissionType !== 'percent' &&
                input(
                  'Fixed amount per order',
                  settings.defaultCommissionPerOrder ?? 0,
                  (v) => setSettings((p) => ({ ...p, defaultCommissionPerOrder: Number(v) })),
                  'number',
                )}
              {(settings.defaultCommissionType ?? 'per_order') !== 'per_order' &&
                input(
                  'Percent of subtotal',
                  settings.defaultCommissionPercent ?? 0,
                  (v) => setSettings((p) => ({ ...p, defaultCommissionPercent: Number(v) })),
                  'number',
                )}
              <label className="setup-field">
                Round commission up to
                <select
                  value={settings.commissionRounding ?? 'none'}
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, commissionRounding: e.target.value }))
                  }
                >
                  <option value="none">No rounding</option>
                  <option value="up_100">Next 100</option>
                  <option value="up_500">Next 500</option>
                  <option value="up_1000">Next 1,000</option>
                </select>
              </label>
            </div>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={settings.allowBatching}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    allowBatching: e.target.checked,
                  }))
                }
              />{' '}
              Allow riders to batch orders
            </label>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={!!settings.requireCashierConfirmForPickup}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    requireCashierConfirmForPickup: e.target.checked,
                  }))
                }
              />{' '}
              Only the cashier can confirm pickup (“Hand to rider”)
            </label>
            <div className="full-row merchant-settings">
              <p className="setup-field-label">Mobile money merchant codes</p>
              <p className="muted">
                Riders show these to customers who pay by mobile money. Leave a code empty to hide
                that provider.
              </p>
              {(
                [
                  ['airtelMerchantCode', 'Airtel Money merchant code'],
                  ['airtelMerchantName', 'Airtel merchant name'],
                  ['mtnMerchantCode', 'MTN MoMo merchant code'],
                  ['mtnMerchantName', 'MTN merchant name'],
                ] as const
              ).map(([key, label]) => (
                <label className="setup-field" key={key}>
                  {label}
                  <input
                    value={settings[key] || ''}
                    onChange={(e) => setSettings((p) => ({ ...p, [key]: e.target.value }))}
                    inputMode={key.endsWith('Code') ? 'numeric' : undefined}
                  />
                </label>
              ))}
            </div>
            <button className="setup-submit" disabled={busy || preview}>
              Save settings
            </button>
          </form>
        </div>
      )}
      {section === 'Settings' && !preview && (
        <div className="admin-panel">
          <h2>Your password</h2>
          <p className="muted">Changing it signs you out of your other devices.</p>
          <ChangePin />
        </div>
      )}
      {section === 'Settings' && (
        <div className="admin-panel">
          <h2>Access rules</h2>
          <p className="muted">
            Re-applies database permissions and assigns missing rider and cashier codes. Run it once
            after each deployment that changes Cloud Code; it is safe to run again.
          </p>
          <button
            className="setup-submit"
            disabled={busy || preview}
            onClick={() => void save('adminApplySecurity', {}, () => {})}
          >
            Apply security rules
          </button>
        </div>
      )}
    </div>
  );
}

export function CommissionEditor({
  member,
  disabled,
  save,
}: {
  member: Pick<Member, 'commissionType' | 'commissionPerOrder' | 'commissionPercent'>;
  disabled: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [type, setType] = useState(member.commissionType),
    [flat, setFlat] = useState(member.commissionPerOrder),
    [percent, setPercent] = useState(member.commissionPercent);
  return (
    <div className="commission-editor">
      <label>
        Commission rule
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="per_order">Fixed per order</option>
          <option value="percent">Percent of subtotal</option>
          <option value="hybrid">Fixed + percent</option>
        </select>
      </label>
      {type !== 'percent' && (
        <label>
          Fixed amount
          <input
            type="number"
            min="0"
            value={flat}
            onChange={(e) => setFlat(Number(e.target.value))}
          />
        </label>
      )}
      {type !== 'per_order' && (
        <label>
          Percent
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
          />
        </label>
      )}
      <button
        disabled={disabled}
        onClick={() =>
          void save({
            commissionType: type,
            commissionPerOrder: flat,
            commissionPercent: percent,
          })
        }
      >
        Save rule
      </button>
    </div>
  );
}

function CategoryEditor({
  category,
  disabled,
  save,
}: {
  category: Category;
  disabled: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(category.title);
  return (
    <div className="setup-row">
      <input aria-label="Category name" value={title} onChange={(e) => setTitle(e.target.value)} />
      <span>{category.active ? 'Active' : 'Hidden'}</span>
      <button
        disabled={disabled || !title.trim()}
        onClick={() => void save({ title, active: category.active })}
      >
        Save name
      </button>
      <button disabled={disabled} onClick={() => void save({ title, active: !category.active })}>
        {category.active ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

function AccompanimentEditor({
  accompaniment,
  disabled,
  save,
}: {
  accompaniment: Accompaniment;
  disabled: boolean;
  save: (payload: Partial<Accompaniment>) => Promise<void>;
}) {
  const [title, setTitle] = useState(accompaniment.title);
  return (
    <div className="setup-row">
      <input
        aria-label="Accompaniment name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <span>
        {!accompaniment.active ? 'Archived' : accompaniment.available ? 'Available' : 'Sold out'}
      </span>
      <button disabled={disabled || !title.trim()} onClick={() => void save({ title })}>
        Save name
      </button>
      {accompaniment.active && (
        <button
          disabled={disabled}
          onClick={() => void save({ available: !accompaniment.available })}
        >
          {accompaniment.available ? 'Sold out' : 'Available'}
        </button>
      )}
      <button disabled={disabled} onClick={() => void save({ active: !accompaniment.active })}>
        {accompaniment.active ? 'Archive' : 'Restore'}
      </button>
    </div>
  );
}

// Which accompaniments a dish offers, in groups. "Pick at most 1" makes a
// group one-or-the-other (e.g. vegetable rice OR fried rice).
function GroupsEditor({
  groups,
  accompaniments,
  onChange,
}: {
  groups: Group[];
  accompaniments: Accompaniment[];
  onChange: (groups: Group[]) => void;
}) {
  const update = (index: number, patch: Partial<Group>) =>
    onChange(groups.map((g, i) => (i === index ? fixLimits({ ...g, ...patch }) : g)));
  return (
    <div className="groups-editor">
      <p className="setup-field-label">Accompaniments (free)</p>
      {!accompaniments.length && (
        <p className="muted">Add accompaniments above first, then choose them here.</p>
      )}
      {groups.map((group, index) => (
        <fieldset className="group-card" key={index}>
          <div className="group-head">
            <input
              aria-label="Group name"
              value={group.label}
              onChange={(e) => update(index, { label: e.target.value })}
              placeholder="Group name, e.g. Rice"
            />
            <button
              type="button"
              className="setup-secondary"
              onClick={() => onChange(groups.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          <div className="choices">
            {accompaniments.map((a) => {
              const on = group.options.includes(a.id);
              return (
                <button
                  type="button"
                  key={a.id}
                  className={on ? 'choice active' : 'choice'}
                  aria-pressed={on}
                  onClick={() =>
                    update(index, {
                      options: on
                        ? group.options.filter((id) => id !== a.id)
                        : [...group.options, a.id],
                    })
                  }
                >
                  {a.title}
                </button>
              );
            })}
          </div>
          <div className="group-limits">
            <label>
              Pick at most
              <input
                type="number"
                min={1}
                max={Math.max(1, group.options.length)}
                value={group.max}
                onChange={(e) => update(index, { max: Number(e.target.value) || 1 })}
              />
            </label>
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={group.min > 0}
                onChange={(e) => update(index, { min: e.target.checked ? 1 : 0 })}
              />{' '}
              Required
            </label>
            <small className="muted">
              {group.max === 1 ? 'One or the other, not both.' : `Up to ${group.max}.`}
            </small>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        className="setup-secondary"
        disabled={!accompaniments.length}
        onClick={() => onChange([...groups, { label: '', options: [], min: 0, max: 1 }])}
      >
        + Add accompaniment group
      </button>
    </div>
  );
}

function fixLimits(group: Group): Group {
  const count = Math.max(1, group.options.length);
  const max = Math.min(Math.max(1, group.max), count);
  return { ...group, max, min: Math.min(group.min, max) };
}
