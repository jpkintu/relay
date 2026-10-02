import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, MapPin, Minus, Plus, ShoppingBag, X } from 'lucide-react';
import Parse from '../parse';
import { useSession } from '../lib/session';
import { applyTheme } from '../lib/theme';
import { formatMoney } from '../lib/format';
import { feeByDistance } from '../lib/geo';
import { PinSheet } from './MapPin';

// The restaurant's public menu (online.js): customers order for pick-up or
// delivery without signing in, pay cash on pick-up / delivery or by mobile
// money, then follow the order on its tracking page.
//
// Addresses: /order (the restaurant of this address), /order/<code>
// (RelayEats Hosted without restaurant subdomains), and …/t/<token> for an
// order's tracking page.

type Group = {
  label: string;
  min: number;
  max: number;
  options: { id: string; title: string; price: number }[];
};
type Dish = {
  id: string;
  title: string;
  category: string;
  price: number;
  description: string;
  image: string | null;
  accompanimentGroups: Group[];
};
type Account = { provider: string; label: string; code: string; name: string; auto: boolean };
type Branch = { id: string; name: string; address: string; phone: string; main: boolean };
type Menu = {
  enabled: boolean;
  open?: boolean;
  pickup?: boolean;
  delivery?: boolean;
  cash?: boolean;
  note?: string;
  mobileMoney?: Account[];
  deliveryFee?: number;
  // Deliveries priced by distance from the branch (0: the flat fee).
  deliveryPerKm?: number;
  origin?: { lat: number; lng: number } | null;
  restaurant: {
    name: string;
    logo: string | null;
    theme: { ink?: string; accent?: string };
    currencySymbol: string;
  };
  branches?: Branch[];
  branchId?: string;
  categories?: string[];
  items?: Dish[];
};
type Line = {
  key: string;
  id: string;
  title: string;
  unit: number;
  quantity: number;
  sides: string[];
  sideNames: string[];
};

// /order[/<code>][/t/<token>]
export function orderPath(pathname: string) {
  const parts = pathname.split('/').filter(Boolean).slice(1);
  if (parts[0] === 't') return { code: '', token: parts[1] || '' };
  return { code: parts[0] || '', token: parts[1] === 't' ? parts[2] || '' : '' };
}

// The orders this phone placed lately, so a customer who closes the page
// finds them again on the menu (no sign-in: the tracking token is the key).
const ORDERS_KEY = 'relay:orders';
const KEEP_MS = 2 * 86400000;
type Saved = { token: string; at: number };
export function savedOrders(code: string, now = Date.now()): Saved[] {
  try {
    const list: Saved[] = JSON.parse(localStorage.getItem(`${ORDERS_KEY}:${code}`) || '[]');
    // The single last order kept before this list.
    const last = localStorage.getItem(`relay:last-order:${code}`);
    if (last && !list.some((o) => o.token === last)) list.push({ token: last, at: now });
    return list.filter((o) => o && typeof o.token === 'string' && now - o.at < KEEP_MS);
  } catch {
    return [];
  }
}
function storeOrders(code: string, list: Saved[]) {
  try {
    localStorage.setItem(`${ORDERS_KEY}:${code}`, JSON.stringify(list.slice(0, 10)));
    localStorage.removeItem(`relay:last-order:${code}`);
  } catch {
    // Private mode: the link in the address bar still works.
  }
}
const rememberOrder = (code: string, token: string) =>
  storeOrders(code, [
    { token, at: Date.now() },
    ...savedOrders(code).filter((o) => o.token !== token),
  ]);
const forgetOrders = (code: string, tokens: string[]) =>
  storeOrders(
    code,
    savedOrders(code).filter((o) => !tokens.includes(o.token)),
  );

export function OnlineOrder() {
  const session = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const fromPath = orderPath(pathname);
  // RelayEats Hosted: the restaurant this address is for.
  const code =
    fromPath.code ||
    ('restaurantCode' in session
      ? String((session as { restaurantCode?: string }).restaurantCode || '')
      : '');
  const params = useMemo(() => {
    const out: Record<string, string> = {};
    if (code) out.restaurant = code;
    return out;
  }, [code]);
  const base = fromPath.code ? `/order/${fromPath.code}` : '/order';
  if (fromPath.token)
    return <Tracking token={fromPath.token} params={params} onMenu={() => navigate(base)} />;
  return (
    <MenuPage
      params={params}
      code={code}
      onPlaced={(token) => {
        rememberOrder(code, token);
        navigate(`${base}/t/${token}`);
      }}
      onTrack={(token) => navigate(`${base}/t/${token}`)}
    />
  );
}

// This phone's orders still on their way, at the top of the menu.
function YourOrders({
  params,
  code,
  onTrack,
}: {
  params: Record<string, string>;
  code: string;
  onTrack: (token: string) => void;
}) {
  const [active, setActive] = useState<(Tracked & { token: string })[]>([]);
  useEffect(() => {
    const saved = savedOrders(code).slice(0, 5);
    if (!saved.length) return;
    let live = true;
    void Promise.all(
      saved.map((o) =>
        Parse.Cloud.run('getOnlineOrder', { ...params, token: o.token }).then(
          (order: Tracked) => ({ ...order, token: o.token }),
          (e: unknown) =>
            // Gone for good (not a lost connection): forget it.
            /Order not found/.test(String((e as Error)?.message))
              ? { token: o.token, gone: true }
              : null,
        ),
      ),
    ).then((rows) => {
      if (!live) return;
      const done = rows
        .filter((r) => r && ('gone' in r || FINISHED.includes((r as Tracked).status)))
        .map((r) => r!.token);
      if (done.length) forgetOrders(code, done);
      setActive(
        rows.filter(
          (r): r is Tracked & { token: string } =>
            !!r && !('gone' in r) && !FINISHED.includes(r.status),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [params, code]);
  if (!active.length) return null;
  return (
    <section className="om-yours" aria-label="Your orders">
      <h2>Your order{active.length > 1 ? 's' : ''}</h2>
      {active.map((order) => (
        <button key={order.token} className="om-yours-row" onClick={() => onTrack(order.token)}>
          <span>
            <b>Order {order.orderCode}</b>
            <small>{stepLabel(order)}</small>
          </span>
          <span className="om-yours-go">
            {formatMoney(order.total, order.restaurant.currencySymbol)} · Track
          </span>
        </button>
      ))}
    </section>
  );
}

function useMoneyOf(symbol: string) {
  return useCallback((amount: number) => formatMoney(amount, symbol), [symbol]);
}

function Header({ menu }: { menu: Menu['restaurant'] }) {
  return (
    <header className="om-header">
      {menu.logo ? (
        <img src={menu.logo} alt="" className="om-logo" />
      ) : (
        <span className="om-logo om-initial" aria-hidden>
          {menu.name.charAt(0)}
        </span>
      )}
      <h1>{menu.name}</h1>
    </header>
  );
}

function MenuPage({
  params,
  code,
  onPlaced,
  onTrack,
}: {
  params: Record<string, string>;
  code: string;
  onPlaced: (token: string) => void;
  onTrack: (token: string) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState('');
  const [branchId, setBranchId] = useState('');
  const [category, setCategory] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState<Dish | null>(null);
  const [checkout, setCheckout] = useState(false);

  useEffect(() => {
    Parse.Cloud.run('getOnlineMenu', { ...params, ...(branchId && { branchId }) })
      .then((data: Menu) => {
        setMenu(data);
        applyTheme(data.restaurant.theme);
        document.title = `${data.restaurant.name} · Order online`;
        if (data.branchId && !branchId) setBranchId(data.branchId);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the menu'));
    // A new branch: its own menu (and an empty basket).
  }, [params, branchId]);

  const money = useMoneyOf(menu?.restaurant.currencySymbol || '');
  const items = useMemo(() => menu?.items || [], [menu]);
  const categories = useMemo(
    () => (menu?.categories || []).filter((c) => items.some((item) => item.category === c)),
    [menu, items],
  );
  const shown = category ? items.filter((item) => item.category === category) : items;
  const count = lines.reduce((n, line) => n + line.quantity, 0);
  const subtotal = lines.reduce((n, line) => n + line.unit * line.quantity, 0);

  const add = (dish: Dish, sides: string[] = []) => {
    const options = dish.accompanimentGroups.flatMap((g) => g.options);
    const picked = options.filter((o) => sides.includes(o.id));
    const key = `${dish.id}:${[...sides].sort().join(',')}`;
    setLines((all) => {
      const found = all.find((line) => line.key === key);
      if (found)
        return all.map((line) =>
          line.key === key ? { ...line, quantity: Math.min(50, line.quantity + 1) } : line,
        );
      return [
        ...all,
        {
          key,
          id: dish.id,
          title: dish.title,
          unit: dish.price + picked.reduce((n, o) => n + o.price, 0),
          quantity: 1,
          sides,
          sideNames: picked.map((o) => o.title),
        },
      ];
    });
  };
  const change = (key: string, by: number) =>
    setLines((all) =>
      all
        .map((line) => (line.key === key ? { ...line, quantity: line.quantity + by } : line))
        .filter((line) => line.quantity > 0),
    );

  if (error)
    return (
      <main className="om-shell">
        <p className="om-closed">{error}</p>
      </main>
    );
  if (!menu)
    return (
      <main className="om-shell">
        <p className="om-loading">Loading the menu…</p>
      </main>
    );
  if (!menu.enabled)
    return (
      <main className="om-shell">
        <Header menu={menu.restaurant} />
        <p className="om-closed">{menu.restaurant.name} does not take online orders yet.</p>
      </main>
    );

  return (
    <main className="om-shell">
      <Header menu={menu.restaurant} />
      <div className="om-status">
        <span className={`om-pill ${menu.open ? 'ok' : 'closed'}`}>
          {menu.open ? 'Taking orders' : 'Not taking orders right now'}
        </span>
        <span className="om-modes">
          {[menu.pickup && 'Pick-up', menu.delivery && 'Delivery'].filter(Boolean).join(' · ')}
        </span>
      </div>
      <YourOrders params={params} code={code} onTrack={onTrack} />
      {menu.note && <p className="om-note">{menu.note}</p>}
      {!!menu.branches?.length && (
        <label className="om-branch">
          Branch
          <select
            value={branchId}
            onChange={(e) => {
              setLines([]);
              setBranchId(e.target.value);
            }}
          >
            {menu.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.address ? ` · ${b.address}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {categories.length > 1 && (
        <nav className="om-cats" aria-label="Menu sections">
          <button className={!category ? 'active' : ''} onClick={() => setCategory('')}>
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={category === c ? 'active' : ''}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </nav>
      )}
      {!items.length && <p className="om-closed">Nothing on the menu right now.</p>}
      <ul className="om-dishes">
        {shown.map((dish) => (
          <li key={dish.id} className="om-dish">
            {dish.image && <img src={dish.image} alt="" loading="lazy" />}
            <div className="om-dish-text">
              <b>{dish.title}</b>
              {dish.description && <small>{dish.description}</small>}
              <span className="om-price">{money(dish.price)}</span>
            </div>
            <button
              className="om-add"
              disabled={!menu.open}
              aria-label={`Add ${dish.title}`}
              onClick={() => (dish.accompanimentGroups.length ? setChoosing(dish) : add(dish))}
            >
              <Plus aria-hidden /> Add
            </button>
          </li>
        ))}
      </ul>

      {count > 0 && !checkout && (
        <button className="om-basket" onClick={() => setCheckout(true)}>
          <ShoppingBag aria-hidden />
          <span>
            {count} item{count === 1 ? '' : 's'}
          </span>
          <b>{money(subtotal)}</b>
          <span className="om-basket-go">View order</span>
        </button>
      )}

      {choosing && (
        <SidesSheet
          dish={choosing}
          money={money}
          onClose={() => setChoosing(null)}
          onAdd={(sides) => {
            add(choosing, sides);
            setChoosing(null);
          }}
        />
      )}
      {checkout && (
        <Checkout
          menu={menu}
          lines={lines}
          money={money}
          params={params}
          branchId={branchId}
          onChange={change}
          onClose={() => setCheckout(false)}
          onPlaced={onPlaced}
        />
      )}
      <footer className="om-footer">Ordering by RelayEats</footer>
    </main>
  );
}

// Choosing the sides of a dish (each group: at least min, at most max).
function SidesSheet({
  dish,
  money,
  onClose,
  onAdd,
}: {
  dish: Dish;
  money: (n: number) => string;
  onClose: () => void;
  onAdd: (sides: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const counts = dish.accompanimentGroups.map(
    (g) => g.options.filter((o) => picked.includes(o.id)).length,
  );
  const ready = dish.accompanimentGroups.every((g, i) => counts[i] >= g.min);
  const toggle = (group: Group, index: number, id: string) =>
    setPicked((all) => {
      if (all.includes(id)) return all.filter((x) => x !== id);
      // One choice: swap it. More: add while there is room.
      if (group.max === 1)
        return [...all.filter((x) => !group.options.some((o) => o.id === x)), id];
      return counts[index] < group.max ? [...all, id] : all;
    });
  const extra = dish.accompanimentGroups
    .flatMap((g) => g.options)
    .filter((o) => picked.includes(o.id))
    .reduce((n, o) => n + o.price, 0);
  return (
    <div className="om-sheet" role="dialog" aria-modal="true" aria-label={dish.title}>
      <div className="om-sheet-card">
        <div className="om-sheet-head">
          <h2>{dish.title}</h2>
          <button className="om-icon" aria-label="Close" onClick={onClose}>
            <X aria-hidden />
          </button>
        </div>
        {dish.accompanimentGroups.map((group, index) => (
          <fieldset key={group.label} className="om-group">
            <legend>
              {group.label}
              <small>
                {group.min > 0
                  ? group.max === 1
                    ? 'Choose one'
                    : `Choose ${group.min} to ${group.max}`
                  : group.max === 1
                    ? 'Optional, one'
                    : `Optional, up to ${group.max}`}
              </small>
            </legend>
            {group.options.map((option) => (
              <label key={option.id} className="om-option">
                <input
                  type={group.max === 1 ? 'radio' : 'checkbox'}
                  name={`g${index}`}
                  checked={picked.includes(option.id)}
                  onChange={() => toggle(group, index, option.id)}
                  onClick={() => {
                    // A radio clicked again clears an optional choice.
                    if (group.max === 1 && group.min === 0 && picked.includes(option.id))
                      setPicked((all) => all.filter((x) => x !== option.id));
                  }}
                />
                <span>{option.title}</span>
                {option.price > 0 && <small>+{money(option.price)}</small>}
              </label>
            ))}
          </fieldset>
        ))}
        <button className="om-primary" disabled={!ready} onClick={() => onAdd(picked)}>
          Add · {money(dish.price + extra)}
        </button>
      </div>
    </div>
  );
}

function Checkout({
  menu,
  lines,
  money,
  params,
  branchId,
  onChange,
  onClose,
  onPlaced,
}: {
  menu: Menu;
  lines: Line[];
  money: (n: number) => string;
  params: Record<string, string>;
  branchId: string;
  onChange: (key: string, by: number) => void;
  onClose: () => void;
  onPlaced: (token: string) => void;
}) {
  const accounts = menu.mobileMoney || [];
  const [type, setType] = useState<'pickup' | 'delivery'>(menu.pickup ? 'pickup' : 'delivery');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [notes, setNotes] = useState('');
  const [method, setMethod] = useState<'cash' | 'mobile_money'>(
    menu.cash ? 'cash' : 'mobile_money',
  );
  const [provider, setProvider] = useState(accounts[0]?.provider || '');
  const [payer, setPayer] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The same order sent again (a lost connection) is placed once.
  const [requestId] = useState(
    () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );

  const subtotal = lines.reduce((n, line) => n + line.unit * line.quantity, 0);
  // By distance: the branch's pin to the customer's (the server checks it).
  const perKm = Number(menu.deliveryPerKm) || 0;
  const byKm = type === 'delivery' && perKm > 0 && !!menu.origin;
  const distance =
    byKm && location && menu.origin ? feeByDistance(menu.origin, location, perKm) : null;
  const needsPin = byKm && !location;
  const fee = type !== 'delivery' ? 0 : byKm ? (distance?.fee ?? 0) : Number(menu.deliveryFee) || 0;
  const total = subtotal + fee;
  const account = accounts.find((a) => a.provider === provider);

  const locate = () => {
    setError('');
    // Browsers share the location only with https pages.
    if (!window.isSecureContext || !navigator.geolocation)
      return setError(
        'This browser cannot share your location here. Open the link in Chrome or Safari, or pin your place on the map.',
      );
    setLocating(true);
    const found = (pos: GeolocationPosition) => {
      setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setLocating(false);
    };
    const failed = (e: GeolocationPositionError) => {
      setLocating(false);
      setError(
        e.code === e.PERMISSION_DENIED
          ? 'Location is blocked for this page. Allow location for this site in the browser settings (in WhatsApp or Facebook, open the link in Chrome or Safari first), or pin your place on the map.'
          : 'Could not find your location. Turn on location (GPS) on the phone and try again, or pin your place on the map.',
      );
    };
    // GPS first; indoors it often times out, so then the network's position.
    navigator.geolocation.getCurrentPosition(
      found,
      (e) =>
        e.code === e.PERMISSION_DENIED
          ? failed(e)
          : navigator.geolocation.getCurrentPosition(found, failed, {
              enableHighAccuracy: false,
              timeout: 20000,
              maximumAge: 300000,
            }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  const place = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result: { token: string } = await Parse.Cloud.run('placeOnlineOrder', {
        ...params,
        branchId,
        requestId,
        items: lines.map((line) => ({
          id: line.id,
          quantity: line.quantity,
          accompaniments: line.sides,
        })),
        customerName: name,
        customerPhone: phone,
        orderType: type,
        deliveryAddress: address,
        ...(location && { location }),
        notes,
        paymentMethod: method,
        ...(method === 'mobile_money' && {
          paymentProvider: provider,
          paymentReference: account?.auto ? '' : reference,
          payerPhone: payer || phone,
        }),
      });
      onPlaced(result.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The order did not go through. Try again.');
      setBusy(false);
    }
  };
  return (
    <>
      {pinning && (
        <PinSheet
          title="Where should we deliver?"
          hint="Tap the map where you are, or drag the pin."
          initial={location}
          around={location ?? menu.origin}
          onSave={(pin) => {
            setLocation(pin);
            setError('');
          }}
          onClose={() => setPinning(false)}
        />
      )}
      <div className="om-sheet" role="dialog" aria-modal="true" aria-label="Your order">
        <form className="om-sheet-card om-checkout" onSubmit={(e) => void place(e)}>
          <div className="om-sheet-head">
            <button
              type="button"
              className="om-icon"
              aria-label="Back to the menu"
              onClick={onClose}
            >
              <ChevronLeft aria-hidden />
            </button>
            <h2>Your order</h2>
          </div>
          <ul className="om-lines">
            {lines.map((line) => (
              <li key={line.key}>
                <span>
                  <b>{line.title}</b>
                  {line.sideNames.length > 0 && <small>{line.sideNames.join(', ')}</small>}
                </span>
                <span className="om-qty">
                  <button
                    type="button"
                    aria-label="One less"
                    onClick={() => onChange(line.key, -1)}
                  >
                    <Minus aria-hidden />
                  </button>
                  {line.quantity}
                  <button type="button" aria-label="One more" onClick={() => onChange(line.key, 1)}>
                    <Plus aria-hidden />
                  </button>
                </span>
                <span className="om-line-total">{money(line.unit * line.quantity)}</span>
              </li>
            ))}
          </ul>
          {!lines.length && <p className="muted">Your order is empty.</p>}

          {menu.pickup && menu.delivery && (
            <div className="om-toggle" role="radiogroup" aria-label="Pick-up or delivery">
              {(['pickup', 'delivery'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  className={type === t ? 'active' : ''}
                  aria-pressed={type === t}
                  onClick={() => setType(t)}
                >
                  {t === 'pickup' ? 'Pick-up' : 'Delivery'}
                </button>
              ))}
            </div>
          )}
          <label className="om-field">
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </label>
          <label className="om-field">
            Phone number
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="e.g. 0772 123456"
              required
            />
          </label>
          {type === 'delivery' && (
            <>
              <label className="om-field">
                Delivery address
                <textarea
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Area, street, building, a landmark"
                />
              </label>
              <div className="om-locate">
                <button type="button" className="om-secondary" onClick={locate} disabled={locating}>
                  <MapPin aria-hidden />
                  {locating ? 'Finding you…' : 'Use my location'}
                </button>
                <button type="button" className="om-secondary" onClick={() => setPinning(true)}>
                  {location ? 'Move the pin' : 'Pin it on the map'}
                </button>
              </div>
              {location ? (
                <small className="om-located">
                  <CheckCircle2 aria-hidden /> Location added
                  {distance ? ` · ${distance.km} km from us` : ''}
                </small>
              ) : (
                byKm && (
                  <small className="muted">
                    Delivery is {money(perKm)} per km: add your location to see the charge.
                  </small>
                )
              )}
            </>
          )}
          <label className="om-field">
            Notes (optional)
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. no onions, call when outside"
            />
          </label>

          <fieldset className="om-pay">
            <legend>Payment</legend>
            {menu.cash && (
              <label className="om-option">
                <input
                  type="radio"
                  name="pay"
                  checked={method === 'cash'}
                  onChange={() => setMethod('cash')}
                />
                <span>{type === 'delivery' ? 'Cash on delivery' : 'Cash when you pick up'}</span>
              </label>
            )}
            {accounts.length > 0 && (
              <label className="om-option">
                <input
                  type="radio"
                  name="pay"
                  checked={method === 'mobile_money'}
                  onChange={() => setMethod('mobile_money')}
                />
                <span>Mobile money now</span>
              </label>
            )}
            {method === 'mobile_money' && (
              <div className="om-momo">
                {accounts.length > 1 && (
                  <div className="om-toggle">
                    {accounts.map((a) => (
                      <button
                        type="button"
                        key={a.provider}
                        className={provider === a.provider ? 'active' : ''}
                        onClick={() => setProvider(a.provider)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {account?.auto ? (
                  <>
                    <label className="om-field">
                      {account.label} number to pay from
                      <input
                        type="tel"
                        value={payer}
                        onChange={(e) => setPayer(e.target.value)}
                        placeholder={phone || 'e.g. 0772 123456'}
                      />
                    </label>
                    <small className="muted">
                      You get a request on this phone: approve {money(total)} with your mobile money
                      PIN.
                    </small>
                  </>
                ) : account ? (
                  <>
                    <p className="om-paycode">
                      Pay <b>{money(total)}</b> to {account.label} merchant code{' '}
                      <b>{account.code}</b>
                      {account.name ? ` (${account.name})` : ''}, then type the transaction ID from
                      the SMS.
                    </p>
                    <label className="om-field">
                      Transaction ID
                      <input
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        autoCapitalize="characters"
                        required
                      />
                    </label>
                  </>
                ) : null}
              </div>
            )}
          </fieldset>

          <dl className="om-totals">
            <div>
              <dt>Food</dt>
              <dd>{money(subtotal)}</dd>
            </div>
            {(fee > 0 || byKm) && (
              <div>
                <dt>
                  Delivery
                  {distance && (
                    <small>
                      {' '}
                      ({distance.km} km × {money(perKm)})
                    </small>
                  )}
                </dt>
                <dd>{needsPin ? 'Add your location' : money(fee)}</dd>
              </div>
            )}
            <div className="om-total">
              <dt>Total</dt>
              <dd>{money(total)}</dd>
            </div>
          </dl>
          {error && <p className="om-error">{error}</p>}
          <button className="om-primary" disabled={busy || !lines.length || !menu.open || needsPin}>
            {busy
              ? 'Placing your order…'
              : needsPin
                ? 'Add your location to order'
                : `Place order · ${money(total)}`}
          </button>
        </form>
      </div>
    </>
  );
}

type Tracked = {
  orderCode: string;
  status: string;
  orderType: 'pickup' | 'delivery';
  customerName: string;
  deliveryAddress: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: string;
  paymentStatus: string;
  payRequestStatus: string;
  paid: boolean;
  cancelReason: string;
  lines: { name: string; quantity: number; sides: string[]; total: number }[];
  restaurant: { name: string; logo: string | null; currencySymbol: string };
};

// Orders that need no more following.
const FINISHED = ['DELIVERED', 'CANCELLED'];

// Where an order is: received, being prepared, ready / on the way, done.
function stepOf(order: Tracked) {
  const s = order.status;
  if (s === 'PLACED') return 0;
  if (s === 'ACCEPTED' || s === 'PREPARING') return 1;
  if (s === 'READY' || s === 'PICKED_UP') return 2;
  return 3;
}

function stepsOf(order: Tracked) {
  const pickup = order.orderType === 'pickup';
  return [
    'Order received',
    'Being prepared',
    pickup
      ? 'Ready to collect'
      : order.status === 'PICKED_UP'
        ? 'On the way'
        : 'Ready, waiting for the rider',
    pickup ? 'Collected' : 'Delivered',
  ];
}
const stepLabel = (order: Tracked) =>
  order.status === 'CANCELLED' ? 'Cancelled' : stepsOf(order)[stepOf(order)];

function Tracking({
  token,
  params,
  onMenu,
}: {
  token: string;
  params: Record<string, string>;
  onMenu: () => void;
}) {
  const [order, setOrder] = useState<Tracked | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setOrder(await Parse.Cloud.run('getOnlineOrder', { ...params, token }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the order');
    }
  }, [params, token]);
  useEffect(() => {
    void load();
    // Every few seconds until it is done.
    const timer = window.setInterval(() => void load(), 6000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (order?.restaurant) document.title = `${order.orderCode} · ${order.restaurant.name}`;
  }, [order]);

  const money = useMoneyOf(order?.restaurant.currencySymbol || '');
  if (!order)
    return (
      <main className="om-shell">
        <p className={error ? 'om-closed' : 'om-loading'}>{error || 'Loading your order…'}</p>
        <button className="om-secondary" onClick={onMenu}>
          Back to the menu
        </button>
      </main>
    );

  const cancelled = order.status === 'CANCELLED';
  const step = stepOf(order);
  const pickup = order.orderType === 'pickup';
  const steps = stepsOf(order);
  const payment =
    order.paymentMethod === 'cash'
      ? order.paid
        ? 'Paid. Thank you!'
        : pickup
          ? `Pay ${money(order.total)} when you collect.`
          : `Pay ${money(order.total)} in cash to the rider.`
      : order.paymentStatus === 'VERIFIED'
        ? 'Paid by mobile money. Thank you!'
        : order.paymentStatus === 'REJECTED'
          ? 'Your mobile money payment was not received. Call the restaurant, or pay when you get your food.'
          : order.payRequestStatus === 'pending' || order.payRequestStatus === 'queued'
            ? `Approve the ${money(order.total)} request on your phone with your mobile money PIN.`
            : 'The restaurant is checking your mobile money payment.';

  const cancel = async () => {
    if (!window.confirm('Cancel this order?')) return;
    setBusy(true);
    try {
      await Parse.Cloud.run('cancelOnlineOrder', { ...params, token });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="om-shell">
      <Header menu={{ ...order.restaurant, theme: {} }} />
      <section className="om-track">
        <p className="om-code">Order {order.orderCode}</p>
        {cancelled ? (
          <p className="om-closed">
            This order was cancelled{order.cancelReason ? `: ${order.cancelReason}` : ''}.
          </p>
        ) : (
          <ol className="om-steps">
            {steps.map((label, index) => (
              <li
                key={label}
                className={index < step ? 'done' : index === step ? 'now' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                {index <= step ? <CheckCircle2 aria-hidden /> : <span className="om-dot" />}
                {label}
              </li>
            ))}
          </ol>
        )}
        {!cancelled && <p className="om-payment">{payment}</p>}
        {!pickup && order.deliveryAddress && (
          <p className="muted small">Delivering to {order.deliveryAddress}</p>
        )}
        <ul className="om-lines readonly">
          {order.lines.map((line, i) => (
            <li key={i}>
              <span>
                <b>
                  {line.quantity}× {line.name}
                </b>
                {line.sides.length > 0 && <small>{line.sides.join(', ')}</small>}
              </span>
              <span className="om-line-total">{money(line.total)}</span>
            </li>
          ))}
        </ul>
        <dl className="om-totals">
          {order.deliveryFee > 0 && (
            <div>
              <dt>Delivery</dt>
              <dd>{money(order.deliveryFee)}</dd>
            </div>
          )}
          <div className="om-total">
            <dt>Total</dt>
            <dd>{money(order.total)}</dd>
          </div>
        </dl>
        {error && <p className="om-error">{error}</p>}
        {order.status === 'PLACED' && (
          <button className="om-secondary" disabled={busy} onClick={() => void cancel()}>
            Cancel the order
          </button>
        )}
        <button className="om-secondary" onClick={onMenu}>
          Back to the menu
        </button>
        <p className="muted small">
          This page updates by itself. Closed it? Open the menu again on this phone to find your
          order.
        </p>
      </section>
      <footer className="om-footer">Ordering by RelayEats</footer>
    </main>
  );
}
