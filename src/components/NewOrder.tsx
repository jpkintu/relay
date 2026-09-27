import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  MapPin,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShoppingBag,
  X,
} from 'lucide-react';
import Parse from '../parse';
import { useConfig, useMoney, useSession } from '../lib/session';
import {
  addToCart,
  cartCount,
  cartSubtotal,
  changeQuantity,
  describeLine,
  previewCommission,
  selectionProblem,
  sidesLabel,
  toggleOption,
  lineTotal,
  extrasOf,
} from '../lib/cart';
import type { AccompanimentOption, CartLine, MenuItem } from '../lib/cart';
import { MobileMoneyPanel, referenceProblem } from './MobileMoney';
import { PinSheet } from './MapPin';
import type { LatLng } from './MapPin';
import { usePrint } from '../lib/print';

const SAMPLE: MenuItem[] = [
  { id: '1', title: 'Smoky chicken bowl', category: 'Mains', price: 18500, color: '#f3b35b' },
  { id: '2', title: 'Beef rolex deluxe', category: 'Mains', price: 12000, color: '#d56b48' },
  { id: '3', title: 'Garden rice plate', category: 'Mains', price: 14500, color: '#90a95f' },
  { id: '4', title: 'Passion fruit juice', category: 'Drinks', price: 6000, color: '#efce58' },
  { id: '5', title: 'Iced hibiscus', category: 'Drinks', price: 5500, color: '#c75c66' },
  { id: '6', title: 'Breakfast chapati', category: 'Breakfast', price: 8000, color: '#d5a966' },
].map((item) => ({ ...item, accompanimentGroups: [] }));

const CHANNELS = [
  ['walkin', 'Walk-in'],
  ['phone', 'Phone'],
  ['whatsapp', 'WhatsApp'],
  ['other', 'Other'],
] as const;
const PAYMENTS = [
  ['cash', 'Cash'],
  ['mobile_money', 'Mobile money'],
] as const;

export type OrderPayload = {
  clientId: string;
  customerName: string;
  customerPhone: string;
  channel: string;
  deliveryAddress: string;
  deliveryNotes: string;
  deliveryFee: number;
  paymentMethod: string;
  paymentProvider?: string;
  paymentReference?: string;
  items: { id: string; quantity: number; notes: string; accompaniments: string[] }[];
  // Counter orders (a cashier taking the order) only:
  orderType?: OrderType;
  riderId?: string;
  table?: string;
  payLater?: boolean;
};

export type OrderType = 'delivery' | 'eat_in' | 'pickup';
// Counter mode: which kinds of order this restaurant takes at the counter.
export type CounterModes = { callIn: boolean; counter: boolean };
type RiderChoice = { id: string; name: string; onShift: boolean; available: boolean };
const TYPES: [OrderType, string][] = [
  ['delivery', 'Delivery'],
  ['eat_in', 'Eat in'],
  ['pickup', 'Pick up'],
];

type Customer = {
  id: string;
  name: string;
  phone: string;
  orderCount: number;
  addresses: { text: string; notes: string; lat?: number; lng?: number }[];
  lastOrder: {
    menuItemId: string;
    title: string;
    quantity: number;
    notes: string;
    accompanimentIds: string[];
    accompanimentNames: string[];
  }[];
};

type Draft = {
  clientId: string;
  name: string;
  phone: string;
  channel: string;
  address: string;
  addressNotes: string;
  location?: LatLng | null;
  cart: CartLine[];
  fee: number | null;
  payment: string;
  provider: string;
  reference: string;
  orderType?: OrderType;
  riderId?: string;
  table?: string;
  payLater?: boolean;
};

const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const emptyDraft = (): Draft => ({
  clientId: newClientId(),
  name: '',
  phone: '',
  channel: 'walkin',
  address: '',
  addressNotes: '',
  location: null,
  cart: [],
  fee: null,
  payment: 'cash',
  provider: '',
  reference: '',
});

function loadDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...emptyDraft(), ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

export function NewOrder({
  onBack,
  onPlaced,
  onGoToCash,
  onOpenOrder,
  preview,
  cashBlocked = '',
  counter,
}: {
  onBack: () => void;
  onPlaced: (
    payload: OrderPayload,
  ) => Promise<{ id?: string; orderCode?: string; cashLimitReached?: boolean } | void>;
  onGoToCash: () => void;
  // Set when the rider is at the cash limit: explains why ordering is blocked.
  cashBlocked?: string;
  onOpenOrder: (id: string) => void;
  preview: boolean;
  // Set when a cashier takes the order at the counter.
  counter?: CounterModes;
}) {
  const config = useConfig();
  const money = useMoney();
  const { profile, user } = useSession();
  const draftKey = `relay:${counter ? 'counter-draft' : 'draft'}:${user?.id || 'preview'}`;
  const restored = useMemo(() => (preview ? null : loadDraft(draftKey)), [draftKey, preview]);
  const [draft, setDraft] = useState<Draft>(() => restored ?? emptyDraft());
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const [items, setItems] = useState<MenuItem[]>(preview ? SAMPLE : []);
  const [menuFee, setMenuFee] = useState(preview ? 3000 : config.defaultDeliveryFee);
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const [pinning, setPinning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const types = counter
    ? TYPES.filter(([type]) => (type === 'delivery' ? counter.callIn : counter.counter))
    : [];
  const orderType: OrderType = counter
    ? types.some(([t]) => t === draft.orderType)
      ? draft.orderType!
      : (types[0]?.[0] ?? 'delivery')
    : 'delivery';
  const isDelivery = orderType === 'delivery';
  const [riders, setRiders] = useState<RiderChoice[]>([]);
  useEffect(() => {
    if (!counter || preview) return;
    Parse.Cloud.run('getAssignableRiders')
      .then(setRiders)
      .catch(() => undefined);
  }, [counter, preview]);
  const { print, printError } = usePrint();
  const [placed, setPlaced] = useState<{
    id?: string;
    orderCode?: string;
    cashLimitReached?: boolean;
  } | null>(null);

  useEffect(() => {
    if (preview) return;
    Parse.Cloud.run('getOperationalMenu')
      .then((data: { items: MenuItem[]; deliveryFee: number }) => {
        setItems(data.items);
        setMenuFee(data.deliveryFee);
      })
      .catch(() => setError('Menu could not be loaded. Please reconnect.'));
  }, [preview]);

  // Keep an unsent order on this phone so a dropped connection loses nothing.
  const hasContent = !!(draft.name || draft.address || draft.cart.length);
  useEffect(() => {
    if (preview) return;
    try {
      if (hasContent) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {
      // Storage unavailable (private mode): the order simply isn't kept.
    }
  }, [draft, draftKey, hasContent, preview]);

  const fee = isDelivery ? (draft.fee ?? menuFee) : 0;
  const subtotal = cartSubtotal(draft.cart);
  const total = subtotal + fee;
  const isCash = draft.payment === 'cash';
  // Riders earn their commission plus the delivery fee.
  const earn = previewCommission(profile?.commission, subtotal, config.commissionRounding) + fee;
  const categories = ['All', ...new Set(items.map((i) => i.category))];
  const filtered = items.filter(
    (i) =>
      (category === 'All' || i.category === category) &&
      i.title.toLowerCase().includes(query.toLowerCase()),
  );
  // Counter orders can be paid later (eat-in / pick-up only).
  const payLater = !!counter && !isDelivery && !!draft.payLater;
  const problems = [
    isDelivery && !draft.name.trim() && 'customer name',
    isDelivery && !draft.address.trim() && !draft.location && 'delivery address or map pin',
    !draft.cart.length && 'at least one item',
    !payLater && !isCash && !draft.provider && 'Airtel or MTN',
    !payLater && !isCash && draft.provider && referenceProblem(draft.reference),
  ].filter(Boolean) as string[];

  const quickAdd = (item: MenuItem) => {
    if (item.accompanimentGroups.length) setSheet(item);
    else update({ cart: addToCart(draft.cart, item, 1) });
  };

  const applyCustomer = (customer: Customer, repeat: boolean) => {
    const address = customer.addresses[0];
    const patch: Partial<Draft> = {
      name: customer.name,
      phone: customer.phone || draft.phone,
      address: address?.text || draft.address,
      addressNotes: address?.notes || draft.addressNotes,
      location:
        address?.lat !== undefined && address?.lng !== undefined
          ? { lat: address.lat, lng: address.lng }
          : address
            ? null
            : draft.location,
    };
    if (repeat) {
      let cart = draft.cart;
      let skipped = 0;
      for (const line of customer.lastOrder) {
        const item = items.find((i) => i.id === line.menuItemId);
        const options = item?.accompanimentGroups.flatMap((g) => g.options) ?? [];
        const chosen = line.accompanimentIds
          .map((id) => options.find((o) => o.id === id))
          .filter(Boolean) as AccompanimentOption[];
        if (
          !item ||
          chosen.length !== line.accompanimentIds.length ||
          selectionProblem(
            item.accompanimentGroups,
            chosen.map((c) => c.id),
          )
        ) {
          skipped += 1;
          continue;
        }
        cart = addToCart(cart, item, line.quantity, chosen, line.notes);
      }
      patch.cart = cart;
      setNotice(
        skipped
          ? `Repeated last order. ${skipped} item(s) skipped: not available right now.`
          : 'Repeated last order.',
      );
    }
    update(patch);
  };

  const place = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await onPlaced({
        clientId: draft.clientId,
        customerName: draft.name.trim(),
        customerPhone: draft.phone.trim(),
        channel: draft.channel,
        deliveryAddress: isDelivery ? draft.address.trim() : '',
        deliveryNotes: isDelivery ? draft.addressNotes.trim() : '',
        ...(isDelivery && draft.location && { location: draft.location }),
        ...(counter && {
          orderType,
          ...(isDelivery && draft.riderId && { riderId: draft.riderId }),
          ...(!isDelivery && { table: (draft.table || '').trim(), payLater }),
        }),
        deliveryFee: fee,
        paymentMethod: draft.payment,
        paymentProvider: isCash || payLater ? undefined : draft.provider,
        paymentReference: isCash || payLater ? undefined : draft.reference.trim(),
        items: draft.cart.map((line) => ({
          id: line.itemId,
          quantity: line.quantity,
          notes: line.notes,
          accompaniments: line.accompaniments.map((a) => a.id),
        })),
      });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // ignore
      }
      setPlaced(result || {});
      // Counter orders: open the print dialog for the kitchen ticket at once.
      if (counter && result?.id && config.receipt?.autoPrintKitchen && !preview)
        void print(result.id, 'kitchen');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not place order');
    } finally {
      setSaving(false);
    }
  };

  if (placed)
    return (
      <div className="success-state">
        <div className="success-check">
          <Check />
        </div>
        <p className="eyebrow">Ticket sent{placed.orderCode ? ` · ${placed.orderCode}` : ''}</p>
        <h2>Order placed.</h2>
        <p>
          {counter
            ? isDelivery
              ? draft.riderId
                ? 'The kitchen has it and the rider has been told.'
                : 'The kitchen has it. Assign a rider from the kitchen board.'
              : payLater
                ? 'The kitchen has it. Take payment from the board before it is served.'
                : 'The kitchen has it.'
            : 'The kitchen has received your order.'}
        </p>
        {placed.cashLimitReached && (
          <p className="limit-banner" role="status">
            This order takes you to your cash limit. Deliver it and hand over the cash before taking
            another order.
          </p>
        )}
        <div className="success-actions">
          {placed.id && !preview && (
            <button className="setup-secondary" onClick={() => onOpenOrder(placed.id!)}>
              View order
            </button>
          )}
          {counter && placed.id && !preview && (
            <div className="print-actions">
              <button className="setup-secondary" onClick={() => void print(placed.id!, 'kitchen')}>
                <Printer /> Kitchen ticket
              </button>
              <button className="setup-secondary" onClick={() => void print(placed.id!, 'receipt')}>
                <Printer /> Receipt
              </button>
            </div>
          )}
          {printError && <p className="ops-error">{printError}</p>}
          {counter && (
            <button
              className="setup-secondary"
              onClick={() => {
                setDraft({ ...emptyDraft(), orderType });
                setPlaced(null);
              }}
            >
              Take another order
            </button>
          )}
          <button className="primary-button" onClick={onBack}>
            {counter ? 'Back to the kitchen board' : 'Back to dashboard'} <ArrowLeft />
          </button>
        </div>
      </div>
    );

  return (
    <div className="order-page">
      <header className="order-head">
        <button className="icon-button" onClick={onBack} aria-label="Back">
          <ArrowLeft />
        </button>
        <div>
          <h2>Create order</h2>
        </div>
        {restored && hasContent && (
          <span className="draft-badge" title="Saved on this phone">
            Draft · not submitted
          </span>
        )}
        {hasContent && (
          <button
            className="setup-secondary clear-draft"
            onClick={() => {
              setDraft(emptyDraft());
              setNotice('');
            }}
          >
            Clear
          </button>
        )}
      </header>
      {cashBlocked && (
        <div className="limit-banner" role="alert">
          <span>{cashBlocked}</span>
          <button onClick={onGoToCash}>Hand over cash</button>
        </div>
      )}

      {counter && (
        <div className="order-type-row">
          <div className="filter-toggle order-type" role="group" aria-label="Kind of order">
            {types.map(([type, label]) => (
              <button
                key={type}
                className={orderType === type ? 'active' : ''}
                aria-pressed={orderType === type}
                onClick={() => update({ orderType: type })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <section className="customer-grid">
        <CustomerField
          optional={!isDelivery}
          value={draft.name}
          onChange={(name) => update({ name })}
          onPick={applyCustomer}
          disabled={preview}
        />
        <label>
          Phone
          <input
            value={draft.phone}
            onChange={(e) => update({ phone: e.target.value })}
            placeholder="07…"
            inputMode="tel"
            autoComplete="off"
          />
        </label>
        <div className="channel-row">
          <span>Channel</span>
          {CHANNELS.map(([value, label]) => (
            <button
              key={value}
              className={draft.channel === value ? 'active' : ''}
              onClick={() => update({ channel: value })}
            >
              {label}
            </button>
          ))}
        </div>
        {!isDelivery && orderType === 'eat_in' && (
          <label>
            Table (optional)
            <input
              value={draft.table || ''}
              onChange={(e) => update({ table: e.target.value })}
              placeholder="e.g. Table 4, terrace"
              maxLength={30}
            />
          </label>
        )}
        {isDelivery && (
          <>
            <label>
              Delivery address
              <input
                value={draft.address}
                onChange={(e) => update({ address: e.target.value })}
                placeholder="Street, area or building"
              />
            </label>
            <label>
              Landmark / notes
              <input
                value={draft.addressNotes}
                onChange={(e) => update({ addressNotes: e.target.value })}
                placeholder="e.g. blue gate, call on arrival"
              />
            </label>
            <div className="pin-row full-row">
              <button type="button" className="pin-button" onClick={() => setPinning(true)}>
                <MapPin />
                {draft.location
                  ? 'Pinned on the map · change'
                  : draft.address.trim()
                    ? 'Pin on the map (optional)'
                    : 'Or pin it on the map'}
              </button>
              {draft.location && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => update({ location: null })}
                >
                  Remove pin
                </button>
              )}
            </div>
            {counter && (
              <label className="full-row">
                Rider
                <select
                  value={draft.riderId || ''}
                  onChange={(e) => update({ riderId: e.target.value })}
                >
                  <option value="">Assign later (from the kitchen board)</option>
                  {riders.map((r) => (
                    <option key={r.id} value={r.id} disabled={r.onShift && !r.available}>
                      {r.name}
                      {!r.onShift ? ' (off shift)' : !r.available ? ' (on a break)' : ''}
                    </option>
                  ))}
                </select>
                <small className="muted">
                  The rider earns the delivery fee only, no commission.
                </small>
              </label>
            )}
          </>
        )}
        {notice && <p className="setup-notice full-row">{notice}</p>}
      </section>

      <section className="menu-section">
        <div className="menu-tools">
          <div className="category-tabs">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={category === c ? 'active' : ''}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="search">
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an item"
            />
          </div>
        </div>
        <div className="menu-grid">
          {filtered.map((i) => {
            const inCart = draft.cart
              .filter((line) => line.itemId === i.id)
              .reduce((n, line) => n + line.quantity, 0);
            return (
              <article className="food-card" key={i.id}>
                {i.image ? (
                  <img className="food-art photo" src={i.image} alt="" loading="lazy" />
                ) : (
                  <div className="food-art" style={{ background: i.color || '#819c72' }}>
                    {i.title[0]}
                  </div>
                )}
                <button className="food-info" onClick={() => setSheet(i)}>
                  <h3>{i.title}</h3>
                  {i.description && <small className="food-description">{i.description}</small>}
                  <p>
                    {money(i.price)}
                    {i.accompanimentGroups.length > 0 && ' · with sides'}
                    {inCart > 0 && <b className="in-cart"> · {inCart} in order</b>}
                  </p>
                </button>
                <button
                  className="add-button"
                  aria-label={`Add ${i.title}`}
                  onClick={() => quickAdd(i)}
                >
                  <Plus />
                </button>
              </article>
            );
          })}
          {!filtered.length && <p className="empty-orders">No items available.</p>}
        </div>
      </section>

      {draft.cart.length > 0 && (
        <section className="menu-section order-summary">
          <p className="eyebrow">This order</p>
          {draft.cart.map((line) => (
            <div className="cart-line" key={line.key}>
              <div>
                <b>{line.title}</b>
                {describeLine(line) && (
                  <small>
                    {[
                      sidesLabel(
                        line.accompaniments.map((a) => a.title),
                        line.accompaniments.map((a) => a.price || 0),
                        money,
                      ),
                      line.notes,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
              </div>
              <div className="qty">
                <button
                  aria-label={`Remove one ${line.title}`}
                  onClick={() => update({ cart: changeQuantity(draft.cart, line.key, -1) })}
                >
                  <Minus />
                </button>
                <strong>{line.quantity}</strong>
                <button
                  aria-label={`Add one ${line.title}`}
                  onClick={() => update({ cart: changeQuantity(draft.cart, line.key, 1) })}
                >
                  <Plus />
                </button>
              </div>
              <span>{money(lineTotal(line))}</span>
            </div>
          ))}

          <div className="bill">
            <div>
              <span>Subtotal</span>
              <b>{money(subtotal)}</b>
            </div>
            {isDelivery && (
              <label>
                <span>Delivery fee</span>
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={fee}
                  onChange={(e) => update({ fee: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            )}
            <div className="bill-total">
              <span>Total</span>
              <b>{money(total)}</b>
            </div>
            <div className="channel-row">
              <span>Payment</span>
              {PAYMENTS.map(([value, label]) => (
                <button
                  key={value}
                  className={!payLater && draft.payment === value ? 'active' : ''}
                  onClick={() => update({ payment: value, payLater: false })}
                >
                  {label}
                </button>
              ))}
              {counter && !isDelivery && (
                <button
                  className={payLater ? 'active' : ''}
                  onClick={() => update({ payLater: true })}
                >
                  Pay later
                </button>
              )}
            </div>
            {payLater && (
              <p className="collect-note full-row">
                An open bill: take payment from the kitchen board before it is served.
              </p>
            )}
            {!payLater && !isCash && (
              <MobileMoneyPanel
                provider={draft.provider}
                reference={draft.reference}
                amount={total}
                customerPhone={draft.phone}
                onProvider={(provider) => update({ provider })}
                onReference={(reference) => update({ reference })}
              />
            )}
            {!payLater && isCash && (
              <p className="collect-note full-row">
                {counter && !isDelivery ? (
                  <>
                    Take <b>{money(total)}</b> in cash now; it goes into your till.
                  </>
                ) : counter ? (
                  <>
                    The rider collects the full <b>{money(total)}</b> in cash at the door.
                  </>
                ) : (
                  <>
                    Collect the full <b>{money(total)}</b> in cash at the door.
                  </>
                )}
              </p>
            )}
          </div>
        </section>
      )}

      <div className="cart-dock">
        <div className="cart-summary">
          <ShoppingBag />
          <span>{cartCount(draft.cart)} items</span>
          <strong>{money(total)}</strong>
        </div>
        <div className="commission">
          {!counter && profile?.commission && draft.cart.length > 0 && (
            <>
              You'll earn <b>{money(earn)}</b> ·{' '}
            </>
          )}
          {error ? (
            <span className="order-error">
              {error}
              {/^(Hand over cash|Cash limit reached)/.test(error) && (
                <button className="link-button" onClick={onGoToCash}>
                  Hand over cash
                </button>
              )}
            </span>
          ) : problems.length ? (
            <span>Needs {problems.join(', ')}</span>
          ) : (
            <span>Ready to send</span>
          )}
        </div>
        <button disabled={!!problems.length || saving || !!cashBlocked} onClick={place}>
          {saving ? 'Sending…' : 'Place order'}
          <ArrowLeft className="arrow-forward" />
        </button>
      </div>

      {pinning && (
        <PinSheet
          title="Where to deliver"
          initial={draft.location ?? null}
          onSave={(location) => update({ location })}
          onClose={() => setPinning(false)}
        />
      )}
      {sheet && (
        <ItemSheet
          item={sheet}
          onClose={() => setSheet(null)}
          onAdd={(quantity, accompaniments, notes) => {
            update({ cart: addToCart(draft.cart, sheet, quantity, accompaniments, notes) });
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

// Customer name with type-ahead from past customers (top 5 by order count).
function CustomerField({
  value,
  onChange,
  onPick,
  disabled,
  optional = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick: (customer: Customer, repeat: boolean) => void;
  disabled: boolean;
  optional?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Customer[]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    if (disabled || !open || value.trim().length < 2) {
      setMatches([]);
      return;
    }
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      Parse.Cloud.run('searchCustomers', { q: value.trim() })
        .then((rows: Customer[]) => id === requestId.current && setMatches(rows))
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [value, open, disabled]);

  return (
    <label className="typeahead">
      {optional ? 'Customer name (optional)' : 'Customer name'}
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 200)}
        placeholder="Start typing a name or phone"
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <div className="suggestions" role="listbox">
          {matches.map((customer) => (
            <div className="suggestion" key={customer.id}>
              <button type="button" onMouseDown={() => onPick(customer, false)}>
                <b>{customer.name}</b>
                <small>
                  {[customer.phone, customer.addresses[0]?.text, `${customer.orderCount} orders`]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                {customer.lastOrder.length > 0 && (
                  <small>
                    Last:{' '}
                    {customer.lastOrder.map((line) => `${line.quantity}× ${line.title}`).join(', ')}
                  </small>
                )}
              </button>
              {customer.lastOrder.length > 0 && (
                <button
                  type="button"
                  className="repeat-button"
                  onMouseDown={() => onPick(customer, true)}
                  title="Repeat last order"
                >
                  <RotateCcw size={15} /> Repeat
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </label>
  );
}

// Bottom sheet: accompaniments (only available ones are sent by the server),
// quantity and kitchen notes for one dish.
function ItemSheet({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (quantity: number, accompaniments: AccompanimentOption[], notes: string) => void;
}) {
  const money = useMoney();
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const problem = selectionProblem(item.accompanimentGroups, selected);
  const options = item.accompanimentGroups.flatMap((g) => g.options);
  // Charged sides add to each unit of the dish.
  const unit = item.price + extrasOf(options.filter((o) => selected.includes(o.id)));
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h2>{item.title}</h2>
            <p>{money(item.price)}</p>
            {item.description && <p className="sheet-description">{item.description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {item.accompanimentGroups.map((group) => (
          <div className="sheet-group" key={group.label}>
            <p>
              <b>{group.label}</b>{' '}
              <small>
                {group.max === 1 ? 'Pick one' : `Pick up to ${group.max}`}
                {group.min > 0 ? ' · required' : ' · optional'}
                {group.options.every((o) => !o.price) ? ' · free' : ''}
              </small>
            </p>
            <div className="choices">
              {group.options.map((option) => (
                <button
                  key={option.id}
                  className={selected.includes(option.id) ? 'choice active' : 'choice'}
                  onClick={() => setSelected((s) => toggleOption(group, s, option.id))}
                  aria-pressed={selected.includes(option.id)}
                >
                  {selected.includes(option.id) && <Check size={14} />} {option.title}
                  {!!option.price && <small className="choice-price">+{money(option.price)}</small>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="setup-field">
          Notes for the kitchen
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. no onions, extra soup"
            maxLength={140}
          />
        </label>
        <div className="sheet-actions">
          <div className="qty">
            <button aria-label="Fewer" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Minus />
            </button>
            <strong>{quantity}</strong>
            <button aria-label="More" onClick={() => setQuantity((q) => Math.min(50, q + 1))}>
              <Plus />
            </button>
          </div>
          <button
            className="primary-button"
            disabled={!!problem}
            onClick={() =>
              onAdd(
                quantity,
                selected.map((id) => options.find((o) => o.id === id)!),
                notes,
              )
            }
          >
            {problem || `Add ${quantity} · ${money(unit * quantity)}`}
          </button>
        </div>
      </section>
    </div>
  );
}
